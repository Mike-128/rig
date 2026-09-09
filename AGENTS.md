# Rig — context for coding agents

You are working on **Rig**, a provider-agnostic agent harness. This file is the orientation document: read it, then read the code it points you at. It records the things that are *not* obvious from reading the source, especially provider quirks and invariants that were learned by breaking them.

Repo: https://github.com/Mike-128/rig · License: MIT · Docs: `README.md` (users), `DESIGN.md` (full design, ~660 lines).

---

## 1. What Rig is, and the one idea it is built around

A user has keys to models from several providers, often through a corporate gateway (Azure API Management) where **one virtual key fronts many models from different vendors**. Rig lets them register those keys, see which models the key can actually reach, then design, save, and run agents against any of them — locally, with the keys never leaving the machine.

The structural choice everything else follows from:

> **The wire protocol ("dialect") and route belong to the Model. Authentication belongs to the Connection.**

One key can front a Claude model speaking Anthropic Messages *and* a GPT model speaking OpenAI Chat Completions. If you ever find yourself putting `dialect` on the Connection, you have broken the central premise. This is the one thing that is expensive to retrofit.

Two dialects exist today: `anthropic.messages` and `openai.chat`. Adding a third means writing one adapter, nothing else.

---

## 2. Orientation: where things live

```
packages/core/          the portable brain — no I/O beyond HTTP to providers
  types/                canonical message model, connections/models, run events
  adapters/             one per dialect, built on the official vendor SDKs
  agent/                agent definition schema, validation, YAML round-trip
  engine/               the native agent loop, policy, prompt building, cost
  tools/                built-in tools + the HostServices interface
  skills/               SKILL.md parsing and hashing
  gateway/              gateway profiles, connection resolver, probe classification

apps/runtime/           the local daemon (Hono API + loopback proxy + SQLite)
  src/stores/           SQLite-backed and file-backed stores
  src/routes/           HTTP surface
  src/proxy.ts          the loopback proxy — the only place a real key is used
  src/scheduler.ts      run queue, abort, approval suspension
  src/host.ts           implements HostServices against the stores
  skills/               bundled skills shipped with the app

apps/web/               React UI (Chat, Agents, Skills, Models), SSE-driven
apps/cli/               `rig` CLI
```

Roughly 6,200 lines total: core 2,272 · runtime 1,990 · web 1,588 · cli 381.

**Reading order if you are new:** `packages/core/src/types/canonical.ts` → `packages/core/src/engine/native.ts` → `apps/runtime/src/scheduler.ts` → `apps/runtime/src/proxy.ts`. That is the whole spine.

---

## 3. Architecture

### The request path

```
Web UI / CLI
    │  HTTP + SSE
Runtime API (Hono)  ──►  Scheduler  ──►  Native engine (async generator)
                                              │
                                              ├─► Provider adapter ──► loopback proxy ──► gateway/provider
                                              └─► Tools (policy-gated)
```

### The loopback proxy — why it exists

Engines and vendor SDKs **never see credentials**. Every model call goes to `http://127.0.0.1:<port>/proxy/:connectionId/{anthropic|openai}/...`, authenticated with a per-process `x-rig-proxy-token`. The proxy looks up the model by the `model` field in the request body, rewrites the path onto the real gateway route, and injects the real key.

This buys four things: key injection in exactly one place; path independence (a gateway with unusual routes still looks standard to an SDK); uniform metering; and a natural place to enforce a kill switch later. Keep it that way — do not pass keys into adapters.

### Canonical types

`packages/core/src/types/canonical.ts` defines an Anthropic-shaped message model (content blocks, `tool_use` / `tool_result`, `reasoning`). Anthropic's shape is the superset; it maps down to Chat Completions cleanly, and the reverse is lossy.

Adapters translate both directions, normalize errors into `HarnessError` (`kind` + `retryable`), and degrade when a capability is missing. Provider-specific knobs go in `CanonicalRequest.extensions` or `ToolUseBlock.providerMeta` — **never** as new core fields.

### The engine

`runNativeEngine` is an async generator yielding `RunEventBody`. It does not know about HTTP, SQLite, or the UI. The scheduler consumes it, persists the non-transient events, and broadcasts everything.

Events are split deliberately: **transient** events (`text_delta`, `reasoning_delta`, `tool_use_start`) stream to the UI and are never stored; everything else is appended to an event log. A session's conversation is a *projection* of that log (`projectMessages`), which is what makes replay-after-restart work.

### Agent definitions

Versioned YAML in `~/.rig/agents/<slug>.yaml`, previous versions archived under `history/`. The YAML file is the shareable artifact; SQLite only indexes it. Saving identical content does **not** bump the version.

### Skills

Standard Agent Skills format: a folder with `SKILL.md` (YAML frontmatter `name` + `description`, then markdown body). Progressive disclosure — only names and descriptions enter the system prompt; the model calls `load_skill` to read a body. User skills in `~/.rig/skills/` shadow bundled ones of the same name. Content-hashed.

### Harness-management tools, and why the agent builder is not special

`HostServices` (`packages/core/src/tools/host.ts`) lends tools access to the agent, model, and skill stores. That backs six tools: `agent_list`, `agent_read`, `agent_write`, `model_list`, `skill_list`, `skill_write`.

The seeded `agent-builder` is an **ordinary agent** that happens to hold those tools. There is no special "builder mode". Consequence: any agent the user creates can be granted the same tools, so agents that build agents are a configuration choice, not a feature. Preserve this property.

---

## 4. Build, run, test

Requires Node 22.13+ (uses the built-in `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm typecheck          # all four packages
pnpm test               # 51 tests: 33 core + 18 runtime
pnpm build              # builds the web UI into apps/web/dist
pnpm dev:runtime        # runtime on :7777 (tsx watch)
pnpm dev:web            # Vite on :5173, proxies /api to :7777
pnpm rig -- <args>      # CLI, e.g. pnpm rig -- agent list
```

The runtime serves the built UI at `/` when `apps/web/dist` exists; otherwise `/` returns a page explaining how to build it. For a one-shot production-ish run: `pnpm start`.

**Do not use a Bash tool to run the dev server** if your harness offers a managed preview mechanism; prefer that.

### Testing approach

Tests run against a **mock upstream** (`apps/runtime/test/mock-upstream.ts`) that speaks both dialects, so no API keys are needed and no money is spent. It deliberately mimics real provider quirks (see §6). `apps/runtime/test/e2e.test.ts` walks the whole product: probe → create agent → save → run with a tool call and an approval → restart → replay.

When you fix a provider-compatibility bug, encode it in the mock so it becomes a standing regression test rather than a one-time fix.

---

## 5. Runtime state

```
~/.rig/
  rig.db            SQLite (WAL): connections, models, aliases, sessions, runs, events
  agents/           versioned agent YAML + history/
  skills/           user skills (shadow bundled)
  profiles/         user-supplied gateway profiles (JSON)
  workspaces/       per-session scratch directories
```

Keys live in the **OS keychain** under service `rig` (legacy service `harness` is read once and copied forward). If the keychain is unavailable, the runtime falls back to AES-256-GCM files under `~/.rig/secrets` and says so at startup. Keys are never in the database, never in the repo, never sent to the UI — the UI sees only the last 4 characters.

Env: `RIG_HOME`, `RIG_PORT` (default 7777), `RIG_MAX_RUNS` (default 4), `RIG_URL` (clients).

---

## 6. Provider quirks — read this before touching adapters

These cost real debugging time. They are not documented anywhere obvious.

**Gemini streams tool arguments as complete objects, not partial fragments.** OpenAI streams partial JSON that you concatenate into one object. Gemini's OpenAI-compatible endpoint sends several *complete* objects for the same call — typically empty placeholders first — so naive concatenation produces `{}{}{"name":"agent-design"}`, which is not valid JSON. `parseToolArguments` (`packages/core/src/adapters/tool-args.ts`) parses normally, then falls back to reading successive JSON values and merging them, later fragments winning. This broke *every* tool-using agent on Gemini.

**Gemini 3 requires `thought_signature` to be echoed back.** Its OpenAI-compatible endpoint returns a signature in `tool_calls[].extra_content.google.thought_signature`. If you do not send it back on the assistant turn, the follow-up request fails with a **400 and an empty body**. This is why `ToolUseBlock.providerMeta` exists — it round-trips opaque provider data verbatim. Any new adapter that has per-call provider state should use the same mechanism.

**Preview models carry much tighter quota.** `ensureDefaultAlias` (`apps/runtime/src/catalog.ts`) prefers curated catalog entries over discovered ones, and generally available models over anything matching `preview|experimental|exp`. A default bound to a preview model 429s almost immediately.

**A 400 during a probe means "entitled".** `classifyProbeError` treats a validation error as proof the key reached the model; only 401/403/404 mean not entitled. Do not "fix" this.

**Providers return bare status lines.** `429 status code (no body)` tells a user nothing, so `errorFromStatus` humanizes those into actionable sentences. Keep real provider messages untouched.

---

## 7. Invariants — do not break these

1. **Keys never leave the runtime process.** Adapters get a proxy URL, not a credential.
2. **`dialect` and `route` on the Model; `auth` on the Connection.** (§1)
3. **The event log is append-only.** Conversation state is a projection of it, never a separately mutated structure. Transient events are never persisted.
4. **Tool results are data, never instructions.** Anything instruction-shaped inside a tool result is shown to the user, not acted on.
5. **Side-effecting tools default to approval-gated.** `file_write`, `shell`, `agent_write`, `skill_write`. Approval suspends the run; denial returns an error result to the model rather than silently continuing.
6. **The workspace jail holds.** `resolveInWorkspace` rejects escapes; file tools are relative to the session workspace. Sandbox 0 forbids writes and process spawn entirely.
7. **SQLite sidecars travel with the database.** Any code that moves `rig.db` must move `-wal` and `-shm` with it. Renaming the main file alone orphans committed rows — this actually happened during the Rig rename and lost real data.
8. **Skills require `load_skill`.** Attaching skills without that tool is a validation error, since the agent could never read them.

---

## 8. Conventions

- TypeScript throughout, strict mode, ESM. pnpm workspace.
- Comments explain **why**, not what. Do not narrate the code.
- Use the official vendor SDKs (`@anthropic-ai/sdk`, `openai`), never hand-rolled HTTP to providers, and never an OpenAI-compatible shim for Anthropic.
- Use SDK types rather than redefining equivalents.
- Errors: typed exception classes and `HarnessError`, never string-matching messages.
- Validation with Zod at boundaries (`AgentDefinitionSchema`, route bodies).
- Web UI is plain React with hash routing and no state library; pages follow the URL via an effect so back/forward works.

---

## 9. Known gaps and open work

- **Cost shows `$0.0000` for discovered models.** Models found by listing carry no pricing, and the bundled Gemini catalog predates the 3.5–3.8 models. The clean fix is a per-model pricing editor in the Models page, not chasing provider catalogs in a static file.
- **Repo folder is still `C:\Users\Michael\Harness`** on the author's machine while the project is Rig. Cosmetic.
- **`@rig` npm scope is unverified.** Irrelevant while every package is `private: true`.
- **Designed but not built** (all specified in `DESIGN.md`): sub-agents and the run tree (§6.8), parallel scheduling beyond the simple queue (§6.9), handoffs and declarative workflows (§6.10), the Workbench entry point and chat→agent task escalation (§8), MCP tool sources, the enterprise control plane with kill switch and telemetry (§7), and the Claude Agent SDK / OpenAI Agents SDK engines (§6.4).

The engine contract in `DESIGN.md` §6.4 is the intended seam for those vendor engines: they execute an engine-neutral Agent Definition and emit the same `RunEvent` stream, so tracing, policy, and halts stay uniform.

---

## 10. History

`DESIGN.md` is the full design record, versioned v0.1 → v0.6, and its "Decisions to review" and "Open questions" sections explain *why* choices were made. Sections 14.1–14.3 describe the implemented slice.

Six commits tell the build story: initial v1 slice → skills + conversational agent builder → Gemini fixes → rename to Rig. `git log` messages are detailed and worth reading when touching adapters or migrations.
