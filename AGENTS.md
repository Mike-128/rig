# Rig — context for coding agents

You are working on **Rig**, a provider-agnostic agent harness. This file is the orientation document: read it, then read the code it points you at. It records the things that are *not* obvious from reading the source, especially provider quirks and invariants that were learned by breaking them.

Repo: https://github.com/Mike-128/rig · License: MIT · Docs: `README.md` (users), `DESIGN.md` (full design, ~660 lines).

---

## 1. What Rig is, and the one idea it is built around

A user has keys to models from several providers, often through a corporate gateway (Azure API Management) where **one virtual key fronts many models from different vendors**. Rig lets them register those keys, see which models the key can actually reach, then design, save, and run agents against any of them — locally, with the keys never leaving the machine.

Since v0.3 it is also a desktop coding companion in the mould of Claude Code: open a project folder and the seeded Coder agent reads, searches, edits, runs commands, plans with a task list, and delegates to sub-agents, under per-session permission modes. The aim is parity in feel (responsive, steerable, capable), not feature-for-feature.

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

  src/mcp.ts            MCP client manager: ~/.rig/mcp.json -> tools named mcp__<server>__<tool>
  src/project.ts        AGENTS.md / CLAUDE.md / RIG.md loading and platform facts for the prompt
  src/github-skills.ts  skill install from GitHub (preview, fetch, provenance)
  src/github.ts         GitHub sign-in as the user (gh CLI token, PAT, device flow) and REST client; EMU and ghe.com hosts
  src/team.ts           team repo: sync over the REST API, change queue, pull requests built with the Git Data API
  src/stores/memory.ts  personal memory (~/.rig/memory) plus team memory read from the synced repo
  src/stores/settings.ts  preferences for new sessions (~/.rig/settings.json)
  src/routes/settings.ts  /settings, /instructions (~/.rig/RIG.md), and /setup, the facts the Setup checklist is built from
  test/demo.ts          the whole app against the mock model in a throwaway home (`pnpm --filter @rig/runtime demo`)

apps/web/               React UI (Sessions workbench, Agents, Skills, MCP, Models), SSE-driven
apps/desktop/           Electron shell: window, tray, hotkey, notifications, folder picker
apps/cli/               `rig` CLI
```

Roughly 9,900 lines of source (tests excluded): core 3,160 · runtime 3,060 · web 2,860 · desktop 430 · cli 380.

Additional entry points for setup and gateway compatibility:

- `apps/cli/src/doctor.ts` and `apps/cli/test/doctor.test.ts`: bounded local/runtime diagnostics.
- `apps/runtime/src/connection-settings.ts`: connection-header and discovery validation.
- `apps/runtime/src/routes/catalog.ts`, `catalog.ts`, and `stores/connections.ts`: connection settings, discovery, and probes.
- `apps/web/src/ConnectionSettings.tsx` and `pages/Models.tsx`: header table, discovery settings, and model configuration.
- `docs/windows-setup.md`: installation, credentials, certificates, updates, and restart troubleshooting on restricted Windows machines.

**Reading order if you are new:** `packages/core/src/types/canonical.ts` → `packages/core/src/engine/native.ts` → `packages/core/src/engine/policy.ts` → `apps/runtime/src/scheduler.ts` → `apps/runtime/src/proxy.ts`. That is the whole spine. For the UI, `apps/web/src/events.ts` (the reducer) → `apps/web/src/pages/Workbench.tsx`.

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

### The engine loop in more detail

- **Parallel tools.** Within one turn, consecutive read-only calls (`sideEffect: false`) run concurrently; anything side-effecting or approval-gated runs alone, in order. Results are reassembled in call order.
- **Progress.** Tools may call `ctx.onProgress(text)`; the engine yields transient `tool_progress` events (shell output, sub-agent activity).
- **Steering.** `takeSteering()` is drained at turn boundaries: after tool results the text rides in the same user message as the results; after an `end_turn` it becomes the next user turn of the same run. The scheduler's per-session inbox feeds it, and anything left when a run ends starts the next run. `POST /sessions/:id/runs` steers instead of returning 409 when a run is active.
- **Compaction.** When a request's input reaches 80% of `capabilities.maxContextTokens` (200k if unknown), the engine summarizes with a fixed handoff prompt and yields a persisted `compacted` event. `projectMessages` restarts the conversation from the latest `compacted` summary, so the log stays append-only. `/compact` runs a compaction-only run.
- **Sub-agents.** The `task` tool calls `ctx.runSubagent`, which the scheduler implements as a nested engine in the same workspace with no `task` tool (one level only) and no ability to ask for approval: calls that would need approval are denied with an explanation unless the session's mode or rules allow them.
- **Prompt caching.** The Anthropic adapter marks the system prompt and the newest message with `cache_control`; `extensions.promptCaching: false` turns it off.

### Permission modes and rules

`policyForAgent(agent, tools, { mode, rules })` reads the session's mode and "always allow" rules on every call, so changes apply mid-run. Modes: `default` (the agent's approval list), `acceptEdits` (file_edit/file_write pass), `plan` (side-effecting tools denied with an explanation), `auto` (everything the agent may use). MCP tools that are not read-only are always approval-gated. An "always" approval records `allowRuleFor(name, input)`: the tool name, or `shell:<first word [+ subcommand]>`; `ruleMatches` never lets a shell rule match a command containing `; & | ` $ < >` or a newline.

### Team sharing

`TeamManager` keeps a read-only copy of the team repo's default branch under `~/.rig/team/repo`, synced over the REST API (commit → recursive tree → changed blobs; a manifest of blob shas makes syncs incremental). There is no git binary and no local clone. Writes never touch the default branch: `stage()` queues a change, and `openPullRequest()` builds blobs → tree on the base tree → commit → `rig/<login>/<stamp>` ref → pull request, all as the signed-in user. Review state comes back from `/pulls/:n/reviews`; a merged pull request is picked up by the next sync.

Team content plugs into the existing stores as one more source: `AgentStore` reads `repo/agents/*.yaml` (local shadows team; team agents are never written locally), `SkillStore` adds a `team` layer between user and Claude Code, and `MemoryStore` reads `repo/memory/*.md`. Shared agents must bind to an alias, since connections are per person; personal skills an agent lists are staged alongside it. `memory_write` with scope `team` stages a change with `origin: "agent"` and says plainly that nothing is in effect until a human merges it.

### Settings and first run

The web shell has four destinations (Sessions, Agents, Skills, Memory) plus **Settings**, which holds everything that configures Rig: Setup, Models, New sessions, Your instructions, Team and GitHub, MCP servers, About. Old `#/models`, `#/team`, and `#/mcp` links route into it. `GET /api/setup` returns facts, not verdicts; the one judgement it makes is `ready`, true when the `default` alias points at a model whose last probe did not fail (`unprobed` still counts, since an untested model may work). The UI derives the checklist from those facts in `pages/Settings.tsx`, and anything that changes setup state dispatches `rig:setup` so the nav and the welcome screen refresh. The runtime, not the UI, binds `default` on the first successful probe (`ensureDefaultAlias` in `catalog.ts`, which avoids preview models); the Models page only reports what it chose. The add-a-provider form follows rig-probe: a preset with its description, only the fields that preset needs, the rest under Advanced, and probe results summarized as sentences.

### Memory

One fact per markdown file with YAML frontmatter (`name`, `description`, `type`, `author`, `updated`), parsed in `packages/core/src/memory`. Descriptions go into the system prompt under "Memory" when the agent has `memory_read`, framed as possibly stale context that is never instructions; bodies load through `memory_read`. Personal writes apply at once; team writes are staged.

### Agent definitions

Versioned YAML in `~/.rig/agents/<slug>.yaml`, previous versions archived under `history/`. The YAML file is the shareable artifact; SQLite only indexes it. Saving identical content does **not** bump the version.

### Skills

Standard Agent Skills format: a folder with `SKILL.md` (YAML frontmatter `name` + `description`, then markdown body). Progressive disclosure — only names and descriptions enter the system prompt; the model calls `load_skill` to read a body. Content-hashed.

Sources, most specific first on a name clash: project (`<workspace>/.rig/skills`, `<workspace>/.claude/skills`) → user (`~/.rig/skills`, where GitHub installs land with a `.rig-origin.json`) → Claude Code (`~/.claude/skills`, only for the default `~/.rig` home; `RIG_CLAUDE_SKILLS` overrides) → bundled. Store methods take an optional workspace for this reason. `skills: ["*"]` means every installed skill. `/name args` in a session expands into a turn carrying the skill body (`user_message.display` keeps what the user typed), and `@path` mentions attach file contents the same way.

### Harness-management tools, and why the agent builder is not special

`HostServices` (`packages/core/src/tools/host.ts`) lends tools access to the agent, model, and skill stores. That backs six tools: `agent_list`, `agent_read`, `agent_write`, `model_list`, `skill_list`, `skill_write`.

The seeded `agent-builder` is an **ordinary agent** that happens to hold those tools. There is no special "builder mode". Consequence: any agent the user creates can be granted the same tools, so agents that build agents are a configuration choice, not a feature. Preserve this property.

---

## 4. Build, run, test

Requires Node 22.13+ (uses the built-in `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm typecheck          # all four packages
pnpm test               # mock-provider, runtime, and CLI diagnostics tests; use the output for current counts
pnpm build              # builds the web UI into apps/web/dist
pnpm dev:runtime        # runtime on :7777 (tsx watch)
pnpm dev:web            # Vite on :5173, proxies /api to :7777
pnpm desktop            # Electron shell; starts or reuses the runtime
pnpm --filter @rig/runtime demo        # everything against the mock model, throwaway home, :7790
pnpm --filter @rig/runtime demo:fresh  # the same, as a new install, to try Settings > Setup
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

Tests run against a **mock upstream** (`apps/runtime/test/mock-upstream.ts`) that speaks both dialects, so no API keys are needed and no money is spent. It deliberately mimics real provider quirks (see §6), and its "model" picks tools from keywords in the user's text (read, edit, run, find, plan, delegate, skill, "mcp <tool>"; "slow" delays the reply), answering only a tool result in the latest message. `apps/runtime/test/e2e.test.ts` walks the whole product: probe → create agent → save → run with a tool call and an approval → restart → replay. `workbench.test.ts` covers folders, modes, steering, slash skills, mentions, compaction, the attention stream, and GitHub installs; `mcp.test.ts` runs a real stdio MCP server (`test/fixtures/echo-mcp.ts`). `packages/core/test/agentic.test.ts` drives the engine with a scripted adapter.

The desktop shell has a smoke mode: `RIG_DESKTOP_SMOKE=<file.png>` loads the UI, saves a screenshot, and exits (non-zero if it never loaded). Point it at a throwaway runtime with `RIG_URL` or `RIG_HOME` + `RIG_PORT`.

When you fix a provider-compatibility bug, encode it in the mock so it becomes a standing regression test rather than a one-time fix.

---

## 5. Runtime state

```
~/.rig/
  rig.db            SQLite (WAL): connections, models, aliases, sessions, runs, events
  agents/           versioned agent YAML + history/
  skills/           user skills (shadow bundled)
  profiles/         user-supplied gateway profiles (JSON)
  workspaces/       per-session scratch directories (sessions without a project folder)
  mcp.json          MCP servers, Claude Code's mcpServers format
  memory/           personal memory, one note per .md file
  github.json       who is signed in to GitHub, and on which host (the token is in the keychain)
  team/             team.json (repo), repo/ (synced copy), manifest.json, pending.json (queued changes), prs.json
  RIG.md            the user's standing instructions for every project (optional; Settings › Your instructions)
  settings.json     defaults for new sessions: projectAgent, chatAgent, defaultMode (all optional)
```

Keys live in the **OS keychain** under service `rig` (legacy service `harness` is read once and copied forward). If the keychain is unavailable, the runtime falls back to AES-256-GCM files under `~/.rig/secrets` and says so at startup. Keys are never in the database, never in the repo, never sent to the UI — the UI sees only the last 4 characters.

Sessions carry `mode` and `allow_rules` columns, added by an additive migration in `db.ts` (`migrate()`); follow that pattern for new columns.

Env: `RIG_HOME`, `RIG_PORT` (default 7777), `RIG_MAX_RUNS` (default 4), `RIG_URL` (clients and the desktop shell), `RIG_SHELL`, `RIG_HOTKEY`, `RIG_NODE` (Node used by the desktop shell to start the runtime), `RIG_CLAUDE_SKILLS`, `GITHUB_TOKEN` (public skill installs only; the team sign-in is separate).

Connection metadata headers are stored in SQLite `extra_headers`; these values are visible in settings and are **not secret storage**. Discovery overrides persist separately in `connection_discovery`. Keep primary credentials in the existing secret backend. Removing a discovery override restores profile defaults.

### Knowledge folders and persistent notes

Agent definitions can attach named `knowledge` folders (absolute local/mounted/UNC paths) and optionally enable `memory`. The runtime scopes `createHost(app, agent)` to the session's pinned agent version; do not give knowledge tools access to other agents' sources. `knowledge_read` browses/reads bounded UTF-8 excerpts; `knowledge_search` performs bounded literal search. Paths are checked lexically and with realpath; junction/symlink escapes are rejected. Source reads do not expand workspace write access. `apps/runtime/src/knowledge.ts` implements filesystem access so the engine still receives HostServices rather than reading files itself.

`memory_read`/`memory_write` access separate per-agent SQLite notes (`agent_memory`). Writes require sandbox 1, explicit approval, and an expected-content match to prevent stale overwrites. Notes persist across sessions/versions and restarts; deleting the agent cascades to notes. No corpus ingestion or semantic index exists. Retrieved files and notes are reference data, not higher-priority instructions. See `docs/knowledge-folders.md` for limits and privacy semantics, and the runtime knowledge/skills tests for confinement, restart, scheduler retrieval, and cross-session notes coverage.

### Connection headers and discovery

The Models UI supports adding and editing connection-wide metadata headers. The proxy injects them into listing, probes, and inference, including streaming. Header validation rejects authentication/transport overrides, case-insensitive duplicates, invalid names, and line breaks. Configured headers cannot be overridden by SDK request headers. Saving headers resets stale probe statuses while preserving keys and aliases.

Discovery overrides describe a listing dialect, GET route, and inference route template for new models. The listing dialect selects a parser; it does **not** assign one inference dialect to every model on a connection. Inference dialect and route still belong to each Model. `{model}` substitution URL-encodes the listed identifier; existing model configurations are preserved. Listing has a 30-second timeout. Scan inventory lists and probes models and can incur usage; it is not an offline command.

Current listing uses the official provider SDKs. Provider model lists are supported. The explicit `azure-deployments` response format normalizes deployment arrays or `value`/`data` wrappers in the runtime proxy before the SDK consumes them. It uses deployment names and filters for OpenAI chat-capable entries; unsupported shapes and `nextLink` pagination fail explicitly. See `deployment-list.ts` and its synthetic regression tests. Arbitrary inventory formats are not automatically supported. Keep missing/failed discovery visible and do not promise exhaustive entitlement discovery. `apps/runtime/test/connection-settings.test.ts` covers headers, persistence, discovery, and proxy pagination with a synthetic upstream.

---

## 6. Provider quirks — read this before touching adapters

These cost real debugging time. They are not documented anywhere obvious.

**Gemini streams tool arguments as complete objects, not partial fragments.** OpenAI streams partial JSON that you concatenate into one object. Gemini's OpenAI-compatible endpoint sends several *complete* objects for the same call — typically empty placeholders first — so naive concatenation produces `{}{}{"name":"agent-design"}`, which is not valid JSON. `parseToolArguments` (`packages/core/src/adapters/tool-args.ts`) parses normally, then falls back to reading successive JSON values and merging them, later fragments winning. This broke *every* tool-using agent on Gemini.

**Gemini 3 requires `thought_signature` to be echoed back.** Its OpenAI-compatible endpoint returns a signature in `tool_calls[].extra_content.google.thought_signature`. If you do not send it back on the assistant turn, the follow-up request fails with a **400 and an empty body**. This is why `ToolUseBlock.providerMeta` exists — it round-trips opaque provider data verbatim. Any new adapter that has per-call provider state should use the same mechanism.

**Preview models carry much tighter quota.** `ensureDefaultAlias` (`apps/runtime/src/catalog.ts`) prefers curated catalog entries over discovered ones, and generally available models over anything matching `preview|experimental|exp`. A default bound to a preview model 429s almost immediately.

**A 400 during a probe means "entitled".** `classifyProbeError` treats a validation error as proof the key reached the model; only 401/403/404 mean not entitled. Do not "fix" this.

**Some providers reuse tool-call ids** ("call_0" every turn). Anything keyed by call id must be scoped to the run and to calls still open; the UI reducer's `upsertTool` matches by run, call id, and not-done status for this reason. The mock upstream reuses `toolu_1` deliberately.

**Windows PowerShell 5.1 rejects `&&`**, which models write constantly. `detectShell()` prefers Git Bash (never `System32\bash.exe`, which is WSL), then PowerShell 7, then Windows PowerShell, and the environment note tells the model which one it has.

**Electron's binary can silently fail to download** under pnpm's build-script policy. `pnpm-workspace.yaml` allows it, and `pnpm desktop` runs `electron:install` first.

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
9. **Compaction is an event, not a rewrite.** Never delete or edit earlier events to shrink context; append `compacted` and let the projection restart from it.
10. **Model output is hostile HTML.** The UI sanitizes markdown with DOMPurify and escapes raw HTML; the desktop shell adds a strict CSP and keeps the window on Rig's origin. The page holds the approve buttons, so script injection would be a privilege escalation.
11. **A project's own config never runs code by itself.** MCP servers come only from `~/.rig/mcp.json`; a repository's `.mcp.json` is not loaded. Project instruction files and project skills are text and are read, but they cannot add tools.
12. **Nothing reaches the team without review.** Rig never writes to the team repo's default branch; every change is a branch and a pull request opened as the signed-in user, and the repository's protection and reviews decide. Agents can only queue team memory, never merge it.
13. **The team repo is not storage.** Only `TEAM_PATHS` (`agents/`, `skills/`, `memory/`, `README.md`, `rig-team.json`) are synced or written, with size caps; extending that list is a design decision, not a convenience.
14. **The GitHub token stays in the runtime**, in the keychain under `github:<host>`, like model keys. The UI and API see only the login.
15. **The desktop shell holds no agent logic.** It finds or starts the runtime and talks to it over the same HTTP API as the browser. Its preload exposes exactly `pickFolder` and `openPath`.

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
- The manual-model editor is implemented and merged. It supports query parameters and model request settings; see `apps/runtime/test/model-edit.test.ts` for regression coverage. Preserve stored model identity and aliases when editing; route and body model may differ from the saved identifier.
- **Inventory scanning has a local compatibility fix, pending real-gateway validation.** Direct PowerShell listing succeeded while the UI scan did not. The supplied partial inventory contained Azure deployment records: `name` is a deployment identifier, `id` is a resource path, and `properties.model.name` is a model-family name. These are not interchangeable. The outer response wrapper and pagination were not established; do not invent them or claim a parser fix has been validated.
- Pressure-test discovery using synthetic records: provider lists versus deployment metadata, unsupported wrappers, empty/malformed results, pagination, timeout/TLS/auth failures, required headers, route/query preservation, and visible progress/error counts. Compare against the known-working direct listing on the user's machine. Finish with a real short chat when authorized; listing and a validation-only 400 probe are not successful inference.
- Entitlement/access inventories may omit deployment routing metadata. Require a documented mapping instead of guessing routes or deriving API versions from model release dates.

### Public repository and private setup boundary

Keep employer-specific service names, hosts, header names/values, deployment IDs, raw inventories, and account metadata out of public documentation, code, fixtures, commits, and PRs. Use generic examples and synthetic responses. The user's private setup reference is stored outside the repository in their local Documents folder; consult it when explicitly requested for that environment and never copy it into Git. It records working setup and diagnostic commands without the API key or charge-code value. Do not assume another machine has the same path or credentials.

- **Cost shows `$0.0000` for discovered models.** Models found by listing carry no pricing, and the bundled Gemini catalog predates the 3.5–3.8 models. The clean fix is a per-model pricing editor in Settings › Models, not chasing provider catalogs in a static file.
- **Checkout locations vary.** Use the current workspace rather than assuming an older local folder name.
- **`@rig` npm scope is unverified.** Irrelevant while every package is `private: true`.
- **Built since v0.2:** the workbench entry point (§8) with project folders, sub-agents via the `task` tool (one level, results only, no run tree in the UI), MCP tool sources, permission modes, steering, and compaction.
- **Team sharing built (v0.4):** GitHub sign-in (gh CLI, token, device flow), the team repo with reviewed pull requests, team agents, skills, and memory. Not yet: project-scoped memory inside a code repo, handoffs between teammates' sessions, notifying when a teammate's pull request needs your review, and webhooks instead of five-minute polling.
- **Not yet:** a project's `.mcp.json` with per-project approval; MCP resources and prompts (tools only); OAuth for remote MCP servers; image input in the composer; a run tree view for sub-agents; checkpoints/undo of file edits; background shell processes; packaging the desktop app as an installer (it runs from the repo with system Node); handoffs and declarative workflows (§6.10); the enterprise control plane (§7); the vendor SDK engines (§6.4).

The engine contract in `DESIGN.md` §6.4 is the intended seam for those vendor engines: they execute an engine-neutral Agent Definition and emit the same `RunEvent` stream, so tracing, policy, and halts stay uniform.

---

## 10. History

`DESIGN.md` is the full design record, versioned v0.1 → v0.6, and its "Decisions to review" and "Open questions" sections explain *why* choices were made. Sections 14.1–14.3 describe the implemented slice.

The commits tell the build story: initial v1 slice → skills + conversational agent builder → Gemini fixes → rename to Rig → coding tools, permission modes, steering, and GitHub skills → the workbench UI → the desktop shell → MCP. `git log` messages are detailed and worth reading when touching adapters or migrations.
