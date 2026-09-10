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

Additional entry points for setup and gateway compatibility:

- `apps/cli/src/doctor.ts` and `apps/cli/test/doctor.test.ts`: bounded local/runtime diagnostics.
- `apps/runtime/src/connection-settings.ts`: connection-header and discovery validation.
- `apps/runtime/src/routes/catalog.ts`, `catalog.ts`, and `stores/connections.ts`: connection settings, discovery, and probes.
- `apps/web/src/ConnectionSettings.tsx` and `pages/Models.tsx`: header table, discovery settings, and model configuration.
- `docs/windows-setup.md`: installation, credentials, certificates, updates, and restart troubleshooting on restricted Windows machines.

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
pnpm test               # mock-provider and CLI diagnostics tests; use output for current counts
pnpm build              # builds the web UI into apps/web/dist
pnpm dev:runtime        # runtime on :7777 (tsx watch)
pnpm dev:web            # Vite on :5173, proxies /api to :7777
pnpm rig <args>         # CLI, e.g. pnpm rig agent list
pnpm rig doctor --offline # local checks without a running runtime
pnpm rig doctor        # includes runtime checks, no provider request by default
pnpm rig doctor --probe # explicitly probes the default model; may incur usage
```

The runtime serves the built UI at `/` when `apps/web/dist` exists; otherwise `/` returns a page explaining how to build it. For a one-shot production-ish run: `pnpm start`.

**Do not use a Bash tool to run the dev server** if your harness offers a managed preview mechanism; prefer that.

On restricted Windows machines, follow `docs/windows-setup.md`. Use normal PowerShell and the repository-pinned pnpm version, installed with a user-local prefix when needed. Restore `$env:LOCALAPPDATA\rig-tools` on PATH in each terminal: even a full-path launcher needs PATH because nested scripts invoke pnpm. Use `pnpm.cmd` and run environment assignments and commands on separate lines.

Build the UI before `pnpm.cmd rig serve`; restart the runtime after its first UI build because static serving is selected at startup. The built application uses port 7777. Vite on 5173 is optional and requires a separate terminal plus the running runtime. Stop old instances with Ctrl+C before restarting; do not kill unrelated Node processes for an `EADDRINUSE` error. Restore the same account and `RIG_HOME` to retain state. Interrupted runs are not automatically resumed.

For corporate certificate trust, apply approved CA settings in the **runtime's** terminal before starting it. Setting them in Vite or a diagnostic terminal does not update an existing runtime. `NODE_USE_SYSTEM_CA=1` worked on the tested Node 25.4 installation; Rig's minimum Node version alone does not guarantee support. Never disable TLS verification. A keyless root HTTP 404 establishes an HTTP response, not model access.

Doctor supports structured JSON reports and bounded checks. Keep reports free of secrets and raw provider errors. Warnings identify optional or unverified capabilities; a required failure produces exit code 1. Default diagnostics do not establish successful streaming or tool use.

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

Connection metadata headers are stored in SQLite `extra_headers`; these values are visible in settings and are **not secret storage**. Discovery overrides persist separately in `connection_discovery`. Keep primary credentials in the existing secret backend. Removing a discovery override restores profile defaults.

### Connection headers and discovery

The Models UI supports adding and editing connection-wide metadata headers. The proxy injects them into listing, probes, and inference, including streaming. Header validation rejects authentication/transport overrides, case-insensitive duplicates, invalid names, and line breaks. Configured headers cannot be overridden by SDK request headers. Saving headers resets stale probe statuses while preserving keys and aliases.

Discovery overrides describe a listing dialect, GET route, and inference route template for new models. The listing dialect selects a parser; it does **not** assign one inference dialect to every model on a connection. Inference dialect and route still belong to each Model. `{model}` substitution URL-encodes the listed identifier; existing model configurations are preserved. Listing has a 30-second timeout. Scan inventory lists and probes models and can incur usage; it is not an offline command.

Current listing uses the official provider SDKs. An OpenAI-style `data` list with `id` entries is supported; pointing it at an arbitrary deployment inventory does not translate that response. Keep missing/failed discovery visible and do not promise exhaustive entitlement discovery. `apps/runtime/test/connection-settings.test.ts` covers headers, persistence, discovery, and proxy pagination with a synthetic upstream.

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

### Adoption progress and follow-up (2026-09-09)

- Implemented in this checkout: doctor diagnostics, restricted-Windows setup/restart guidance, connection-header editing, and configurable inventory scans. Use actual test output rather than historical fixed counts. Mock tests do not establish access to a real corporate gateway.
- The user confirmed a manually configured deployment works after correcting its route, deployment identifier, required metadata header, API-version query, and token parameter. Treat this as a verified individual configuration, not proof all template models or discovery work.
- The user has also tested a manual-model editor with query parameters in another revision. This checkout does not yet contain that editor. Inspect branch/history before integrating or documenting it as locally available. Preserve stored model identity and aliases when editing; route and body model may differ from the saved identifier.
- **Inventory scanning remains unresolved.** Direct PowerShell listing succeeded while the UI scan did not. The supplied partial inventory contained Azure deployment records: `name` is a deployment identifier, `id` is a resource path, and `properties.model.name` is a model-family name. These are not interchangeable. The outer response wrapper and pagination were not established; do not invent them or claim a parser fix has been validated.
- Pressure-test discovery using synthetic records: provider lists versus deployment metadata, unsupported wrappers, empty/malformed results, pagination, timeout/TLS/auth failures, required headers, route/query preservation, and visible progress/error counts. Compare against the known-working direct listing on the user's machine. Finish with a real short chat when authorized; listing and a validation-only 400 probe are not successful inference.
- Entitlement/access inventories may omit deployment routing metadata. Require a documented mapping instead of guessing routes or deriving API versions from model release dates.

### Public repository and private setup boundary

Keep employer-specific service names, hosts, header names/values, deployment IDs, raw inventories, and account metadata out of public documentation, code, fixtures, commits, and PRs. Use generic examples and synthetic responses. The user's private setup reference is stored outside the repository in their local Documents folder; consult it when explicitly requested for that environment and never copy it into Git. It records working setup and diagnostic commands without the API key or charge-code value. Do not assume another machine has the same path or credentials.

- **Cost shows `$0.0000` for discovered models.** Models found by listing carry no pricing, and the bundled Gemini catalog predates the 3.5–3.8 models. The clean fix is a per-model pricing editor in the Models page, not chasing provider catalogs in a static file.
- **Checkout locations vary.** Use the current workspace rather than assuming an older local folder name.
- **`@rig` npm scope is unverified.** Irrelevant while every package is `private: true`.
- **Designed but not built** (all specified in `DESIGN.md`): sub-agents and the run tree (§6.8), parallel scheduling beyond the simple queue (§6.9), handoffs and declarative workflows (§6.10), the Workbench entry point and chat→agent task escalation (§8), MCP tool sources, the enterprise control plane with kill switch and telemetry (§7), and the Claude Agent SDK / OpenAI Agents SDK engines (§6.4).

The engine contract in `DESIGN.md` §6.4 is the intended seam for those vendor engines: they execute an engine-neutral Agent Definition and emit the same `RunEvent` stream, so tracing, policy, and halts stay uniform.

---

## 10. History

`DESIGN.md` is the full design record, versioned v0.1 → v0.6, and its "Decisions to review" and "Open questions" sections explain *why* choices were made. Sections 14.1–14.3 describe the implemented slice.

Six commits tell the build story: initial v1 slice → skills + conversational agent builder → Gemini fixes → rename to Rig. `git log` messages are detailed and worth reading when touching adapters or migrations.
