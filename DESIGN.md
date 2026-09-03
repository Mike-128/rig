# Rig — Provider-Agnostic Agent Harness, High-Level Design (Draft v0.6)

Status: draft for review. Sections 14.1 to 14.3 are implemented in this repo, plus skills (6.11) and
conversational agent creation via rig-management tools, which arrived earlier than the phase table predicted.
Date: 2026-09-02
Changes since v0.5: added section 14, the first build slice, with a definition of done covering model probing plus creating, saving, running, and replaying a user-designed agent on both dialects.
Changes since v0.4: two entry points (Chat and Workbench) on one runtime, with chat-to-agent escalation through detached tasks (section 8); Session kinds and task events added; clients (web, CLI/TUI, IDE later) defined; phases, decisions, and questions updated.
Changes since v0.3: added multi-agent capabilities (6.8 to 6.12): sub-agents, parallel execution and scheduling, orchestration patterns and workflows, handoffs, and skills; Agent Definition, Run, and event model extended; phases, decisions, and questions updated.
Changes since v0.2: control plane scoped to observability and kill switch only (not an operator surface); keys are runtime-only, firmly; added the local gateway proxy (6.3) and the "what a user needs for a virtual key" spec (6.2); phases, decisions, and questions updated.
Changes since v0.1: split into a local runtime and an enterprise control plane; Claude Agent SDK and OpenAI Agents SDK promoted to first-class runtime engines; gateway discovery changed to a curated route catalog plus entitlement probing; governance (kill switch), telemetry, and the tool-execution recommendation added.

## 1. Goals

- Run chat and agent workloads against models from any provider through a single internal contract.
- First-class support for the Anthropic SDK (Messages API) **and** the Claude Agent SDK, the OpenAI SDK **and** the OpenAI Agents SDK, with a clean path to add more.
- Bring Your Own Model (BYOM): a user can register a direct provider key, a gateway virtual key, or a local endpoint.
- Gateway-first: a single virtual key (an Azure API Management subscription key) fronts many models from different providers, each reached at its own defined endpoint.
- Runs locally on the user's machine, so agents can work with local files, tools, and networks.
- An enterprise control plane observes every runtime and can stop it: a single telemetry sink plus a true kill switch. It is not an operator surface; day-to-day execution and agent management happen in the local runtime.
- A friendly UI to manage provisioned models, chat with them, and build and operate agents.
- Two entry points on the same runtime: a basic chat interface for everyday use, and a dev/coding/agent workbench with the full tool surface. A chat can escalate work to a fully enabled agent and get the result back.

## 2. Non-goals (for now)

- Being a gateway ourselves (rate limiting, quota, and provider-key custody stay in APIM / the provider).
- Training or fine-tuning.
- Hosting agent execution server-side in the first release. The engine contract allows it later (see 6.5).

## 3. The trust chain

```
Model Provider (Anthropic, OpenAI, Azure OpenAI, ...)
      |
APIM gateway  (holds real provider keys, applies policies: quota, token limits, logging)
      |
Virtual Key   (APIM subscription / product key; entitles a set of model endpoints)
      |
User          (receives the key; may also hold direct provider keys or local endpoints)
      |
Local Runtime (stores the key in the OS keychain, probes entitlements, runs playground + agents)
      |
Control Plane (governs and observes runtimes; never holds user keys by default)
```

Consequences:

- The rig never sees provider keys. It only ever holds what the user gives it, on the user's device.
- Usage limits are enforced upstream. The rig meters what it observes for attribution and dashboards, not enforcement.
- One key -> many models -> many endpoints -> possibly many dialects. `dialect` and `route` live on the Model; `auth` lives on the Connection.
- The control plane is an observability and kill-switch layer over runtimes, not a proxy in the request path and not a place where agents are operated. Model traffic never transits it, and it never holds model keys.

## 4. Topology

Two deployable units and one optional shell.

```
+-------------------------------------------------------------------+
|  ENTERPRISE CONTROL PLANE (server)                                |
|  telemetry ingest | usage & cost | audit | fleet dashboard        |
|  kill switch (halt / resume by scope) | identity & enrollment     |
|  optional: guardrail floors, read-only route catalog distribution |
+-----------------------------^-------------------------------------+
                              | outbound, persistent control channel per runtime
                              | (heartbeat, lease, events up; halt commands down)
+-----------------------------+-------------------------------------+
|  LOCAL RUNTIME (daemon on the user's machine)  <- point of execution
|  local web UI (served on localhost; optional desktop shell)       |
|  keys in OS keychain | SQLite (sessions, runs, events, agents)    |
|  runtime engines: native loop | claude-agent-sdk | openai-agents  |
|  local gateway proxy (loopback) + connection resolver             |
|  provider abstraction                                             |
|  tool layer: MCP (stdio/HTTP) | built-ins | sandbox levels        |
|  halt state + lease | telemetry buffer (disk-backed)              |
+-----------------------------+-------------------------------------+
                              | model traffic goes direct
        direct provider | APIM gateway (virtual key) | local endpoint
```

Modes:

- **Standalone**: the local runtime alone. Everything works except central telemetry and the fleet kill switch. Guardrails come from a local config file.
- **Enrolled**: the runtime is registered with a control plane. It pushes events and heartbeats, and accepts halt commands and optional guardrail floors. Agents, keys, and day-to-day operation stay local.

The UI is a web app in both cases. The local runtime serves it on localhost; the control plane serves the fleet console. They share component code, so the run console looks the same on a laptop and in the enterprise view.

## 5. Domain model

| Entity | What it is | Key fields |
|---|---|---|
| **Org / Workspace** | Tenant and team boundary on the control plane | id, name, members, policies |
| **User** | A person; identity from SSO in enrolled mode, local account in standalone | id, subject, roles |
| **Device / Runtime** | One enrolled local runtime | id, userId, hostname, version, lastHeartbeat, leaseExpiry, status |
| **Connection** | An endpoint plus credential | id, owner, kind (`direct` / `gateway` / `local`), baseUrl, auth (header name + keychain ref), extraHeaders, catalogRef |
| **Route Catalog** | Curated list of models reachable through a gateway | gatewayId, entries: {modelId, dialect, route, capabilities, pricing} |
| **Model** | One callable model, resolved from a Connection plus a catalog entry or manual definition | id, connectionId, providerModelId, displayName, dialect, routePath, capabilities, entitlement status |
| **Model Alias** | Stable name an agent binds to (`fast`, `smart`, `vision`) | alias, binding per user or workspace, fallback list |
| **Agent Definition** | Versioned, engine-neutral definition | id, version, name, instructions, model binding, tools, skills, subagents, handoffs, delegation limits, policies, engine + engine settings, memory config |
| **Skill** | A folder with `SKILL.md` (name, description, instructions) plus optional scripts and resources, following the Agent Skills format | id, name, description, source (local dir / git / bundled), contentHash, version |
| **Workflow Definition** | A declarative graph of steps (agents, tools, human gates) with fan-out and fan-in | id, version, steps, edges, inputs, triggers |
| **Tool Source** | Where tools come from | MCP server (stdio / HTTP), built-in pack, HTTP function |
| **Session** | A conversation thread; the container for a run tree | id, kind (`chat` / `workbench` / `task`), agentId + version, userId, deviceId, state, workspace (optional for chat, required for workbench and task), linkedFrom (the session and message that spawned a task) |
| **Run** | One execution of an engine. Root runs come from user turns or workflow steps; child runs from delegation | id, sessionId, rootRunId, parentRunId, depth, role (`root` / `subagent` / `step`), engine, status, budgets (own and rolled-up), startedAt, endedAt |
| **Event** | Append-only record of everything in a run | runId, seq, type, payload, ts |
| **Policy** | Rules the runtime enforces. Authored locally; enrolled runtimes may additionally receive guardrail floors from the control plane | scope (local / agent; optionally org floor), rules (tool allow/deny, approval requirements, sandbox level, budgets, model allowlist, telemetry redaction, fail mode) |
| **Control Command** | A governance action | id, type (`halt`, `resume`, `disable_connection`, `policy_update`), scope, reason, issuedBy, ts |
| **Usage record** | Metered tokens and estimated cost | runId, modelId, connectionId, userId, deviceId, tokens, cost |

### 5.1 Dialects

| Dialect | Backed by | Notes |
|---|---|---|
| `anthropic.messages` | `@anthropic-ai/sdk` with `baseURL` + default headers | Content blocks, thinking, tool_use / tool_result, cache_control, server tools |
| `openai.chat` | `openai` SDK, Chat Completions | Widest compatibility across gateways and local servers |
| `openai.responses` | `openai` SDK, Responses API | Item-based; required by the OpenAI Agents SDK for full features |
| `azure.openai` | `openai` SDK Azure client | Deployment in the path, `api-version` query, `api-key` header |
| `openai.compatible` | `openai` SDK | Ollama, vLLM, LM Studio, LiteLLM; Chat Completions subset |
| Later: `bedrock.messages`, `vertex.messages` | Anthropic provider clients | Behind a gateway these usually collapse into `anthropic.messages` with a custom base URL |

### 5.2 Capability flags

`streaming`, `tools`, `parallelTools`, `strictTools`, `vision`, `pdf`, `structuredOutput`, `reasoning`, `promptCaching`, `maxContextTokens`, `maxOutputTokens`, `pricing {input, output, cachedInput}`.

Sources, in order: route catalog entry, provider models API where the gateway proxies it, dialect defaults, manual override.

## 6. Local runtime

### 6.1 Provider Abstraction Layer (PAL)

A thin canonical layer of our own, with adapters implemented on the official SDKs. Used directly by the native engine and by the playground; the vendor agent SDK engines use their own SDK clients but share the connection resolver.

Canonical types (Anthropic-shaped, the superset that maps down cleanly):

- `CanonicalMessage { role: user | assistant | system; content: Block[] }`
- Blocks: `text`, `image`, `document`, `tool_use {id, name, input}`, `tool_result {toolUseId, content, isError}`, `reasoning {text?, opaque?}`
- `CanonicalRequest { model, system, messages, tools, toolChoice, maxOutputTokens, temperature?, reasoning?: {effort | budget}, responseFormat?, cacheHints?, extensions?, metadata }`
- `CanonicalStreamEvent`: `message_start`, `text_delta`, `reasoning_delta`, `tool_use_start`, `tool_use_delta`, `tool_use_end`, `usage`, `message_end {stopReason}`, `error`
- `StopReason`: `end_turn | tool_use | max_tokens | refusal | other`

```ts
interface ProviderAdapter {
  dialect: Dialect
  capabilities(model: Model): Capabilities
  stream(req: CanonicalRequest, conn: ResolvedConnection): AsyncIterable<CanonicalStreamEvent>
  complete(req: CanonicalRequest, conn: ResolvedConnection): Promise<CanonicalResponse>
  countTokens?(req: CanonicalRequest, conn: ResolvedConnection): Promise<number>
  listModels?(conn: ResolvedConnection): Promise<DiscoveredModel[]>
  normalizeError(err: unknown): RigError   // retryable vs terminal, rate-limit, auth, content-filter
}
```

Adapters translate canonical to provider request and back, extract usage, map errors, and degrade gracefully when a capability is missing (drop the field, record a warning event). Provider-specific knobs go in `extensions`, never in core fields.

### 6.2 Connection resolver and gateway discovery

```
ResolvedConnection = {
  baseUrl:  connection.baseUrl + model.routePath,
  headers:  { [connection.auth.headerName]: keychain.get(ref), ...connection.extraHeaders },
  modelId:  model.providerModelId,
  timeouts, retries
}
```

Because the gateway has a defined endpoint per model, discovery is **catalog plus probe**, not introspection:

1. **Route catalog.** A curated list of gateway models with dialect, route, capabilities, and pricing. In enrolled mode it lives on the control plane and is maintained by the gateway/platform team. In standalone mode it is a local YAML file, with a starter catalog shipped in the app.
2. **Entitlement probe.** When a user adds a virtual key, the runtime sends a minimal request to every catalog route with that key and classifies the result: success or a validation error means entitled; 401/403/404 means not entitled; timeouts are retried and then shown as unknown. The UI shows the resulting list with badges. Re-probe on demand.
3. **Manual add.** A user can define a model by hand (route, dialect) and test it. Manual entries can be promoted into the shared catalog by an admin.

Header defaults: `Ocp-Apim-Subscription-Key` for APIM, `x-api-key` for Anthropic direct, `Authorization: Bearer` for OpenAI direct, `api-key` for Azure OpenAI. All overridable per connection.

Streaming through APIM requires the gateway to not buffer SSE, and the vendor agent SDKs require beta headers to pass through. Both are Phase 0 checks.

#### What the end user needs for an APIM virtual key

In principle: the key and knowledge of which endpoint to call per model. In practice a client needs five facts, and the rig should make the user supply only the first:

| # | Fact | Why it is needed | Who supplies it |
|---|---|---|---|
| 1 | The virtual key | Auth | The user pastes it |
| 2 | Gateway base URL | Where to send traffic | Gateway profile |
| 3 | Auth header name | APIM defaults to `Ocp-Apim-Subscription-Key` but admins often rename it (e.g. `api-key` to look like Azure OpenAI) | Gateway profile |
| 4 | Per-model route, dialect, and the `model` string to put in the body | The route selects the model on the gateway side, but the body still needs a valid `model` field for Anthropic and OpenAI-shaped APIs, and Azure routes need an `api-version` query. The dialect decides which request shape to send | Route catalog |
| 5 | Route behaviors: streaming allowed, beta headers passed through, extra required headers | Decides which engines can use the model and whether streaming is offered in the UI | Route catalog, confirmed by the probe |

Everything except the key is static per gateway, so it belongs in a **gateway profile** that the platform team publishes once and the rig ships or fetches:

```json
{
  "id": "contoso-apim",
  "displayName": "Contoso AI Gateway",
  "baseUrl": "https://ai-gw.contoso.com",
  "auth": { "headerName": "Ocp-Apim-Subscription-Key" },
  "models": [
    { "id": "claude-opus-5", "dialect": "anthropic.messages",
      "route": "/anthropic/v1/messages", "bodyModel": "claude-opus-5",
      "streaming": true, "betaHeaders": true },
    { "id": "gpt-5", "dialect": "azure.openai",
      "route": "/openai/deployments/gpt-5/chat/completions", "query": { "api-version": "2025-04-01-preview" },
      "bodyModel": "gpt-5", "streaming": true },
    { "id": "llama-3.3-70b", "dialect": "openai.chat",
      "route": "/oss/v1/chat/completions", "bodyModel": "llama-3.3-70b", "streaming": true }
  ]
}
```

User flow: pick the gateway profile, paste the key, the runtime probes every route and shows what the key is entitled to. If the platform team has not published a profile, the same form exposes the five fields for manual entry, and a manual profile can be exported and shared.

Two things to confirm with the gateway team, since they change the user experience:

- Is the subscription key the only credential, or does the API also validate an Entra ID JWT? If the latter, the runtime must also sign the user in and attach a bearer token, and the profile needs the app registration details.
- Do the Anthropic-shaped routes follow the standard path layout (`<base>/v1/messages`)? If not, the vendor SDKs cannot be pointed at the gateway directly, which is one of the reasons for the local proxy below.

### 6.3 Local gateway proxy

The runtime exposes a loopback HTTP listener that presents **standard provider-shaped endpoints** and rewrites them onto the real gateway:

```
http://127.0.0.1:<port>/anthropic/v1/messages      -> <gateway>/anthropic/v1/messages   (+ key header)
http://127.0.0.1:<port>/openai/v1/chat/completions -> <gateway>/openai/deployments/<x>/chat/completions?api-version=...
http://127.0.0.1:<port>/openai/v1/responses        -> <gateway>/openai/v1/responses
```

The `model` field in the body selects the catalog entry, so one loopback endpoint per dialect serves every model the user is entitled to. Requests carry a per-runtime loopback token so other local processes cannot borrow the key.

Why this is worth the extra component:

- **Key injection in one place.** Engines and SDKs never touch credentials. The Claude Agent SDK and OpenAI Agents SDK just get a base URL.
- **Path independence.** Whatever layout APIM uses, the SDKs see the layout they expect.
- **Hard kill switch.** A halt closes the proxy for the affected scope, which stops vendor SDK traffic even if a hook is missed.
- **Uniform metering.** Usage blocks and gateway usage headers are captured on every response regardless of engine.
- **Future SDKs for free.** Anything that speaks Anthropic or OpenAI wire format can be pointed at the loopback.

The native engine may call adapters directly or go through the proxy; going through it keeps one code path for metering and halts, at the cost of one local hop.

### 6.4 Runtime engines

The backbone of the rig is the engine-neutral **Agent Definition** plus the **Engine contract** below. Vendor agent SDKs are engines that execute a definition; they do not own agent management, because neither the Claude Agent SDK nor the OpenAI Agents SDK stores, versions, shares, or governs agents. That layer is ours. Anthropic's hosted Managed Agents does manage agents, but it is not reachable through an arbitrary gateway, so it is a later option for direct connections only.

```ts
interface RuntimeEngine {
  id: 'native' | 'claude-agent-sdk' | 'openai-agents'
  supports(agent: AgentDefinition, model: Model): { ok: boolean; reason?: string }
  run(input: {
    agent: AgentDefinition; session: Session; userTurn: UserTurn;
    model: ResolvedModel; policy: EffectivePolicy;
    tools: ToolRegistry; signal: AbortSignal;
  }): AsyncIterable<RunEvent>
}
```

Every engine emits the same `RunEvent` stream, so the run console, trace, telemetry, approvals, and kill switch are identical regardless of engine.

| Engine | Works with | What it brings | How it is wired |
|---|---|---|---|
| **native** | Any dialect | Provider-agnostic loop over the PAL. Lightest weight. Default for gateway models that are not Anthropic-dialect and for chat-style agents. | Context builder -> adapter stream -> tool dispatch -> policy gate. Pluggable context management (window, tool-result pruning, summarization, provider-native compaction). |
| **claude-agent-sdk** | `anthropic.messages` models only | The Claude Code harness as a library: file read/write/edit, bash, glob/grep, web tools, subagents, hooks, sessions. Default for coding and filesystem agents on Claude models. | Agent Definition maps to `query()` options (system prompt, allowed tools, MCP servers, permission mode). `PreToolUse` hooks call our policy engine; the abort signal drives halts. The SDK's base URL points at the local gateway proxy (6.3), so it never sees the key or the gateway path layout. |
| **openai-agents** | `openai.responses` preferred, `openai.chat` supported | OpenAI's loop, handoffs, guardrails, tracing. Default for OpenAI-dialect agents that want handoffs. | Agent Definition maps to an `Agent` with our tools wrapped as function tools; the SDK client's base URL points at the local gateway proxy. Tool calls pass through our policy gate before execution. |

Engine selection: explicit on the Agent Definition, with `auto` picking by model dialect and tool needs. `supports()` is validated at save time so a shared agent cannot be bound to a model its engine cannot use.

Rule: the native engine is the only truly provider-agnostic one and must stay feature-complete for chat and tool use. The vendor engines add depth for their own models and are never required for the rig to function.

### 6.5 Enforcement points

Every engine must respect these, and the native engine implements them directly:

- **Before each model call**: check halt state, lease, budgets, model allowlist. The local gateway proxy enforces halt state a second time at the network edge.
- **Before each tool call**: policy evaluate -> `allow | deny | require_approval`. Approval suspends the run and surfaces in the local UI.
- **During streaming**: abort signal cancels the request; the proxy drops the upstream connection.
- **On every event**: append to the local event log, publish to the UI, enqueue for telemetry.

For the Claude Agent SDK engine, hooks and the abort signal cover the first three and the proxy backstops them. For the OpenAI Agents engine, tool wrappers, a model-call hook, the abort signal, and the proxy cover them.

### 6.6 Server-side engines (later)

The engine contract does not care where it runs. A later phase could run the native engine headless on a server for scheduled agents, using the same telemetry and halt paths. That would be a separate execution host, not the control plane, and would need remote sandboxing (level 3 below).

### 6.7 Tool layer and execution recommendation

MCP is the primary tool protocol (stdio for local servers, streamable HTTP for remote). Built-in packs: file read/write/edit inside a workspace, shell, web fetch, HTTP request, code execution, and "ask the user" rendered as a UI prompt.

**Recommendation: graded sandbox levels, default level 1, policy can raise the floor.**

| Level | Execution | Use |
|---|---|---|
| 0 | Read-only tools, no process spawn | Chat agents with lookups only |
| 1 | Local subprocess jailed to an agent workspace directory, allowlisted extra roots, egress allowlist, CPU/time limits | Default. Matches how the Claude Agent SDK already operates and keeps local-file use cases simple |
| 2 | Container (Docker or Podman if present) with the workspace mounted, no host network unless allowed | Opt-in per agent; enforceable by policy for high-risk tool classes (shell with network, code execution of untrusted input) |
| 3 | Remote sandbox service | Control-plane-hosted headless agents; not in the first release |

Why level 1 by default: the whole point of running locally is access to the user's files and tools, and the vendor agent SDKs assume a local process model. Containers add friction and a Docker dependency that not every laptop has. Guardrails close the gap: local policy (or an org floor, if the control plane distributes one) can require level 2 for specific tools or agents, and the runtime refuses to start a run whose engine or environment cannot meet the required level.

Tool safety rules that apply at every level: tool results are data and never instructions; outward-facing tools (send, post, delete, pay) require approval by default; side-effect classification marks read-only tools as parallel-safe.

### 6.8 Sub-agents

A sub-agent is a child Run with its own fresh context, its own budget, and possibly a different model or engine, whose final output returns to the parent as a tool result. Everything a root run has (events, trace, policy, halt, telemetry) a child run has too, so the run tree is the only new concept.

**Spawning.** Every engine gets the same built-in delegation tools, exposed to the model as ordinary tools:

| Tool | Behavior |
|---|---|
| `spawn_agent({agent, input, model?, budget?, wait?})` | Start a child run from a named agent in the local library or an inline definition (instructions + tools). `wait: true` blocks and returns the result; `wait: false` returns a handle. |
| `spawn_parallel([{agent, input}...], {failFast?})` | Fan out N children concurrently, fan in all results in one tool result. |
| `await_agents([handles])` | Join previously started async children. |
| `cancel_agent(handle)` | Cancel a child subtree. |

**Declared sub-agents.** An Agent Definition can list the sub-agents it is allowed to use, each with an alias, an optional model override, and a budget. The delegation tools then only accept those names. An agent with no `subagents` list and `delegation.allowSpawn: false` cannot delegate at all.

**Inheritance rules (narrow only, never widen):**

- Tools: the child's tool set is a subset of what the parent's policy allows, intersected with the child definition's own list.
- Sandbox: child level is at least the parent's level.
- Budget: child budget is deducted from the parent's remaining budget, or fixed if the parent declares `childBudgetPolicy: fixed`. Rolled-up spend is tracked on the root.
- Depth and fan-out: `delegation.maxDepth` (default 3) and `delegation.maxFanOut` (default 8) are enforced by the runtime, not the prompt.
- Approvals: a child's approval requests surface in the parent's session inbox with the run path shown.

**Workspace.** A child inherits the session workspace by default. For parallel file-editing children, the orchestrator can request `workspace: isolated`, which gives each child a copy (a git worktree when the workspace is a repo, a directory copy otherwise) and returns a diff summary. Merging is the orchestrator's responsibility and conflicts are reported, not auto-resolved.

**Cross-engine delegation.** Because a child is just a Run, a Claude Agent SDK parent can delegate to a native-engine child running a GPT model, and vice versa. This is how you get cross-provider teams: a Claude orchestrator with a cheap OpenAI-compatible worker, all metered and halted the same way.

**Engine mapping.**

| Engine | Native sub-agent feature | How the rig uses it |
|---|---|---|
| native | none; the delegation tools above are the mechanism | Direct |
| claude-agent-sdk | Built-in subagents (defined programmatically or as agent files) with a task tool; subagent start/stop hooks | The runtime materializes the definition's `subagents` into the SDK's agent configuration so the SDK's own delegation works, and mirrors each SDK subagent into a child Run via the hooks so tracing and halts stay uniform. The rig delegation tools are also exposed through MCP for cross-engine children. |
| openai-agents | Agents-as-tools and handoffs | Declared sub-agents become agents-as-tools; each invocation is wrapped as a child Run. |

### 6.9 Parallel execution and scheduling

Two kinds of parallelism, one scheduler.

- **Within a run**: parallel tool calls (already supported for parallel-safe tools) and `spawn_parallel` fan-out.
- **Across runs**: several root runs at once on one runtime, whether three agents the user started or a workflow with concurrent steps.

**Scheduler** in the runtime:

- A run queue with per-run `AbortController`, priority (interactive runs ahead of background), and state persisted in the event log so a restart resumes or fails runs cleanly.
- Concurrency limits at three levels: global (default 8 active runs), per agent definition, and per connection. The per-connection limit is the important one for the gateway: it is the runtime's model of the virtual key's rate limit. Each connection carries `maxConcurrent` and `tokensPerMinute` hints from the gateway profile; 429 responses with `retry-after` feed an adaptive backoff shared by every run using that connection.
- Runs are async tasks in the daemon; tool executions are separate processes or containers per the sandbox level. If a single run misbehaves in-process, the daemon isolates it by moving that engine to a worker thread. Start simple, promote if needed.
- Each root run and each workflow gets a token, cost, and wall-clock budget; children draw from it (6.8).

**Halt cascade.** Halting a run halts its subtree. Halting an agent definition halts every run of it, including where it appears as a child. Halting a connection stops every run whose current model uses it and pauses the rest at their next enforcement point.

**Trace.** The run console shows the tree as parallel lanes on a timeline with per-child tokens and cost, and a rolled-up total on the root.

### 6.10 Orchestration

Three levels, added in order. The first two are cheap because they are just tools and definitions; the third is a small workflow runner and should stay small.

**Level 1: prompt-driven orchestration.** An orchestrator agent uses the delegation tools to plan and dispatch work. Patterns that work with nothing more than good instructions and declared sub-agents: orchestrator-workers, router (classify then dispatch), evaluator-optimizer loop, map-reduce over a list. Agent templates for these patterns ship in the library.

**Level 2: handoffs.** A `handoff(agent, reason)` tool transfers control of the current session to another agent definition for the remainder of the turn, carrying the conversation context. Unlike a sub-agent, nothing returns to the caller. Useful for triage-then-specialist flows. Emits a `handoff` event and switches the model, tools, and instructions at the next loop iteration. Handoffs are declared on the definition (`handoffs: [...]`) and validated at save time. The native engine implements this directly; the OpenAI Agents engine maps to its own handoffs; the Claude Agent SDK engine implements it by ending the current query and starting a new one on the same session with the target definition.

**Level 3: declarative workflows.** A Workflow Definition is a graph of steps. Step types: `agent` (run a definition with an input template), `tool` (call a tool directly), `parallel` (fan out a list of steps or map over an array), `condition` (branch on a step output using a small expression language), `human` (pause for approval or input), `loop` (repeat until a condition or a max count). Edges carry data mappings from prior step outputs. Each `agent` step is a root Run inside the workflow's session, so the trace, budgets, halts, and telemetry are unchanged.

Workflow state is event-sourced like runs, so a workflow can pause at a human step for days and resume, and the runtime can resume after a restart. Triggers: manual, schedule (the daemon must be running; the tray shell makes this practical), webhook to the local API, and file-system watch. Retries and timeouts per step.

Deliberate limits: no arbitrary code steps (use an agent or a tool), no cross-runtime workflows in the first release, and the DSL is JSON with a visual editor rather than a programming language. If real durable-execution needs appear (compensation, long-lived timers at scale), adopt an existing engine rather than growing this one.

**Communication between agents.** Results flow through tool returns and workflow edges. A session-scoped **blackboard** (key-value plus named artifacts) is available to every run in the session for shared state such as a plan, a findings list, or a file manifest. Free-form agent-to-agent messaging is not provided; it is hard to trace and easy to loop.

### 6.11 Skills

Skills follow the Agent Skills format: a folder containing `SKILL.md` with frontmatter (`name`, `description`) and an instruction body, plus optional scripts, templates, and reference files. The format is engine-neutral markdown, which is why it is the right unit of portable capability here.

**Progressive disclosure, implemented once and mapped to each engine:**

1. At run start, the names and descriptions of the agent's enabled skills are injected into the system context (a few hundred tokens for dozens of skills).
2. The model loads a skill body on demand through a `load_skill(name)` tool, or the user invokes one directly with `/name`.
3. Files bundled with the skill are readable through the file tools and scripts are runnable through the shell tool, both inside the sandbox level in force. The skill directory is mounted read-only into the workspace.

| Engine | How skills reach the model |
|---|---|
| native | Steps 1 to 3 above, implemented in the context builder and built-in tools |
| claude-agent-sdk | The SDK supports the same skill folder format natively. The runtime materializes the agent's enabled skills into the settings directory it points the SDK at, so the SDK's own skill loading and invocation apply. |
| openai-agents | Steps 1 to 3 via the rig tools wrapped as function tools |

**Skill library.** Sources: bundled starter skills, user-level and project-level directories, git URLs (pinned to a commit), and zip import. Every skill is identified by content hash; an agent definition pins skills by name and hash, so a shared definition behaves the same on another machine once the skill is fetched. The runtime fetches missing skills on import and reports which are unavailable.

**Governance.** Skills can carry scripts, so they are code. Rules: the sandbox level applies to skill scripts; guardrail floors may restrict skill sources to an allowlist of git hosts or a curated org catalog; `skill_loaded` and `skill_script_executed` events go to telemetry; a skill is never auto-updated under a running agent.

**Authoring.** The UI has a skill browser (search, preview, enable per agent) and a "capture as skill" helper that drafts a `SKILL.md` from a session's successful approach for the user to edit.

### 6.12 Agent Definition additions

The fields introduced by 6.8 to 6.11, shown as the definition's own format:

```yaml
name: release-manager
engine: auto
model: smart                      # alias, resolved per user
instructions: |
  Plan the release, delegate research and checks, and produce the changelog.
tools: [files, shell, web_fetch, mcp:github]
skills: [changelog-style, semver-rules, git:https://git.contoso.com/skills/release#a1b2c3d]
subagents:
  - ref: researcher            # a definition in the local library
    as: research
    model: fast
    budget: { tokens: 200000 }
  - ref: test-runner
    as: tests
    workspace: isolated
delegation:
  allowSpawn: true
  maxDepth: 2
  maxFanOut: 6
  childBudgetPolicy: share
handoffs: [incident-commander]
concurrency:
  maxParallelTools: 4
policies:
  sandbox: 1
  approvals: [shell:network, mcp:github:create_release]
  budget: { tokens: 2000000, usd: 10, wallClockMinutes: 60 }
```

Everything here is validated at save time against the chosen engine's `supports()` so a definition cannot be bound to an engine that lacks a feature it uses.

## 7. Control plane

### 7.1 Responsibilities

The control plane is deliberately narrow. It observes and it can stop. It does not operate agents, hold keys, or sit in the request path.

- **Telemetry**: ingest run events, usage, and OpenTelemetry spans from every runtime (7.4). This is the single plane for capture.
- **Kill switch**: halt and resume by scope (7.3).
- **Identity and enrollment**: SSO (Entra ID assumed), device enrollment with a per-runtime credential, revocation.
- **Fleet console**: live runtimes, active runs, cost by model/key/user/agent/device, run explorer with trace, audit log.
- **Optional, read-only distribution**: the gateway route catalog and profiles (6.2), and guardrail floors (minimum sandbox level, tool deny list, telemetry redaction level, fail mode). These are guardrails, not operating controls: they constrain what a runtime may do; they never tell it what to run.

Explicitly out of scope: agent authoring or publishing, approvals on a user's behalf, key custody or distribution, model routing.

### 7.2 Control channel

Each enrolled runtime holds one outbound persistent connection (WebSocket, with long-poll fallback for restrictive networks). Nothing needs to reach into the user's machine.

Up: heartbeat, lease renewal, run lifecycle events, telemetry batches.
Down: halt/resume commands, optional guardrail floors and catalog updates.

Lease semantics: a runtime holds a lease of roughly one minute, renewed on heartbeat. Policy defines the fail mode when the control plane is unreachable:

- `fail_open` with a grace window (default for standalone-friendly rollouts): existing runs continue; after the window, new runs are refused until the channel returns.
- `fail_closed`: runs pause when the lease expires. For high-governance environments.

### 7.3 Kill switch

Scopes, from narrow to wide: run, session, agent (all runs of a definition across the fleet), user, device, connection (disable a key locally), model, workspace, global.

Modes: `pause` (suspend at the next enforcement point, resumable) and `kill` (abort in-flight requests, mark runs cancelled, block new runs).

Enforcement: the command arrives on the control channel, is written to local halt state, and takes effect at the next enforcement point (6.5), plus immediate abort of in-flight streams for `kill`. The local gateway proxy also refuses traffic for the halted scope, which makes the stop hold even for engines whose hooks are bypassed. Every affected run gets a `halted` event with the reason and issuer so the user sees why. Commands are idempotent and carry a sequence number so a reconnecting runtime replays what it missed.

Disabling a connection in the rig is a local block; true revocation is done at APIM. The console can link to both.

### 7.4 Telemetry

- Runtimes buffer events to disk and ship them in batches over the control channel. Offline periods do not lose data.
- Everything is also emitted as OpenTelemetry (run -> turn -> model call -> tool call spans), so an enterprise can route to its existing collector alongside or instead of the control plane.
- Redaction levels set by policy: `metadata` (default: model, tokens, tool names, timings, status), `arguments` (adds tool arguments), `content` (adds prompts and outputs). Content is opt-in and stored encrypted.
- Usage records carry model, connection, user, device, agent, and engine so cost can be sliced any way. Gateway usage headers are captured when present and treated as the source of truth where they disagree.

## 8. Entry points and UI surfaces

### 8.1 Two entry points, one runtime

| | **Chat** | **Workbench** (dev / coding / agent tool) |
|---|---|---|
| Purpose | Everyday conversation, questions, drafting, quick lookups | Building software, running agents against a project, operating workflows |
| Default definition | `assistant`: native engine, `fast` or `smart` alias, tools limited to web fetch, file read from an attachments area, skills, and `start_task` | `coder`: Claude Agent SDK engine on Anthropic-dialect models, native engine otherwise; full tool surface (files, shell, MCP, sub-agents, skills) |
| Workspace | None by default; a scratch area for attachments and artifacts | Required: a project directory, git-aware |
| Sandbox | Level 0 or 1 | Level 1, raised by policy |
| Approvals | Rare; escalation itself is the main gate | Per-tool, with the approval inbox and run tree |
| Presentation | Message thread with task cards | Run console: trace, tree lanes, diffs, terminal output, approvals |
| Any definition allowed? | Yes, the user can switch the chat to any agent in the library; the surface only sets defaults and presentation | Yes |

Both surfaces are views over the same runtime, scheduler, policy engine, and event log. A session's `kind` decides which surface opens it by default, and any session can be opened in the workbench for full detail.

### 8.2 Escalation: chat hands work to an agent

The chat definition has one special tool, `start_task`, and the model or the user can invoke it ("hand this to an agent", or a button on any message).

1. **Brief.** The runtime drafts a structured brief from the conversation: goal, constraints, acceptance criteria, relevant excerpts, files mentioned. The whole chat is not dumped into the agent. The user sees the brief, edits it, picks the workspace (a recent project or a new folder) and the target definition (default `coder`), and confirms. Confirmation is the governance gate for escalation and is on by default; policy can require it always or allow auto-start for specific definitions.
2. **Detached run.** A new Session of kind `task` is created, linked back to the chat session and the originating message. Its root Run goes through the scheduler like any other and executes in the background while the user keeps chatting.
3. **Progress back to chat.** The chat session receives `task_started`, `task_progress` (milestones and approval requests, not every token), and `task_completed` or `task_failed` events, rendered as a task card that updates in place. Approval requests from the task can be answered from the card.
4. **Result.** On completion, a summary plus artifacts (a diff, files, links) return to the chat as a tool result, so the conversation can continue with the outcome in context. "Open in workbench" on the card jumps to the full run console for that task.
5. **Follow-ups.** Replying to a task card sends a new turn into the task session rather than starting over, so iteration happens on the same workspace and context.

Differences from a sub-agent: a task is a root run in its own session, it outlives the chat turn that started it, it has its own workspace and approvals, and it reports back by events rather than a blocking tool return. It shares all the plumbing: budgets, halts (halting the chat session does not halt its tasks; halting the task session does), and telemetry with the link recorded.

The reverse direction also exists: an agent in the workbench can `notify_chat` with a question or a result, which appears as a message in the linked chat. This is how a long-running task asks for a decision without the user watching the console.

### 8.3 Clients

All clients talk to the local runtime's API. None of them embed engines or keys.

- **Web UI** served on localhost: Chat and Workbench plus the catalog, library, and settings surfaces below. Optional Tauri desktop shell for tray presence and auto-start.
- **CLI / TUI**: `rig chat` (terminal chat), `rig code` (terminal-first workbench in the style of Claude Code, attached to the current directory), `rig run <agent> "<input>"` for scripting, `rig tasks` to list and follow background tasks. The TUI is the natural home for the coding workflow and for users who live in the terminal.
- **IDE extension** (later): opens workbench sessions against the editor's workspace, surfaces diffs and approvals inline.

### 8.4 Local UI surfaces

1. **Chat**: message thread, model and agent switcher, attachments, task cards with progress and approvals, "open in workbench".
2. **Workbench**: project picker, run console with trace and tree lanes, diff viewer, terminal output, approval inbox, agent switcher, task list across projects.
3. **Model Catalog**: add a connection, paste key, run the entitlement probe, review models with capability and entitlement badges, test, set aliases.
4. **Playground**: side-by-side compare of models on one prompt, capability-driven parameter panel, live token and cost meter, "save as agent". Lives inside Chat as a compare mode rather than a separate app.
5. **Agent Builder**: instructions, model binding (alias with fallbacks or explicit), engine selection with validation, tool sources with per-tool approval toggles, skills picker, sub-agent and handoff declarations, delegation limits, sandbox level, policies, which surfaces the definition is offered on, versioning with diff, test panel, export/import of agent definitions for sharing between people.
6. **Skill Library**: browse, search, preview, enable per agent, import from git or zip, "capture as skill" from a session.
7. **Workflows**: visual graph editor over the JSON workflow DSL, step types from 6.10, run history, pause/resume at human steps, triggers.
8. **Settings**: enrollment status, local policy and any org guardrail floors (read-only), gateway profiles and local catalog, connection concurrency hints, telemetry status.

### 8.5 Fleet console (served by the control plane)

9. **Fleet**: runtimes and their health, active runs and run trees across the org, kill switch controls by scope.
10. **Insight**: usage and cost dashboards, run explorer with trace, audit log.
11. **Guardrails** (optional): floors editor, route catalog and gateway profile publishing, skill source allowlist, which definitions may be started from chat without confirmation.

## 9. Security

- Keys are distributed to and stored on the individual runtime only, in the OS keychain (DPAPI on Windows, Keychain on macOS, Secret Service on Linux). The control plane stores only metadata (gateway, last4, entitled models) and never receives key material.
- The browser talks only to the local runtime or the control plane. Model traffic originates from the runtime, through the local gateway proxy, which is bound to loopback and requires a per-runtime token.
- Device enrollment issues a per-runtime credential bound to the user's SSO identity; revocation cuts the control channel and, with `fail_closed`, stops runs.
- Local event store and telemetry buffer are encrypted at rest.
- Tool execution per the sandbox levels above; egress allowlists per workspace.
- Audit log on the control plane for policy changes, publishes, control commands, and enrollment events; the local runtime keeps its own audit trail of what it enforced.

## 10. Recommended stack

TypeScript end to end.

- **Local runtime**: Node 22 daemon; Hono for the local API; SQLite via Drizzle; `@anthropic-ai/sdk`, `openai`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@modelcontextprotocol/sdk`. Optional desktop shell with Tauri (tray icon, auto-start, native keychain access) wrapping the same web UI.
- **Control plane**: Node 22, Hono or Fastify, Postgres via Drizzle, Redis for the control-channel fan-out, OpenTelemetry collector-compatible ingest.
- **UI**: React + Vite, TanStack Query/Router, shadcn/ui; one component library shared by the local UI and the fleet console.
- **Repo**: pnpm monorepo: `packages/core` (types, PAL, native engine, policy), `packages/engines-*`, `packages/adapters-*`, `packages/ui`, `apps/runtime`, `apps/control-plane`, `apps/web`, `apps/cli`.

Why TypeScript: both vendor SDKs, both vendor agent SDKs, and the MCP SDK are first-class in TS, the UI is TS regardless, and one language covers runtime, control plane, and UI.

## 11. Phased delivery

| Phase | Outcome | Scope |
|---|---|---|
| **0. Spike** | Prove the chain and the engine strategy | Canonical types; `anthropic.messages` and `openai.chat` adapters; minimal local gateway proxy; CLI chat through a real APIM virtual key with a gateway profile. Claude Agent SDK pointed at the proxy: verify beta-header passthrough and SSE not buffered. Confirm whether Entra JWT is required alongside the key. |
| **1. Local catalog + chat** | A user can register keys and talk to their models | Local runtime with SQLite and keychain, gateway profiles and route catalog, entitlement probe, Model Catalog UI, Chat entry point with streaming and compare mode, `rig chat` CLI, local usage metering. Standalone mode only. |
| **2. Agents + workbench** | A user can build and run agents locally, and escalate from chat | Agent Definition and engine contract; native engine; Claude Agent SDK engine; OpenAI Agents engine; MCP host and built-in packs; sandbox levels 0 to 2; local policy engine; scheduler with concurrency limits and per-connection backoff; Workbench entry point and `rig code` TUI; `start_task` escalation with brief, task cards, and `notify_chat`; Agent Builder with export/import; Run Console with trace and approvals. |
| **2b. Multi-agent and skills** | Teams of agents and reusable capability | Run tree and delegation tools (`spawn_agent`, `spawn_parallel`, `await_agents`, `cancel_agent`); declared sub-agents with inheritance rules; isolated workspaces; handoffs; skills with progressive disclosure on all three engines; skill library and import; run tree UI with lanes and roll-ups; orchestration agent templates. |
| **3. Control plane** | Enterprise observability and kill switch | Enrollment and SSO; control channel with lease and fail modes; kill switch at all scopes with subtree cascade, backstopped by the proxy; telemetry ingest and OTel export; fleet console and dashboards; audit. Optional guardrail floors, catalog distribution, and skill source allowlist. |
| **3b. Workflows** | Declarative orchestration | Workflow DSL and runner (agent, tool, parallel, condition, human, loop steps); event-sourced workflow state with pause and resume; triggers (manual, schedule, webhook, file watch); visual editor; blackboard. |
| **4. Extensibility** | Grow without touching the core | `openai.responses` and `azure.openai` adapters if not already landed; Bedrock, Vertex, Ollama; provider and engine plugin contract; headless execution host with remote sandbox; Managed Agents engine for direct connections; evals and replay regression; durable-execution backend for workflows if needed. |

## 12. Decisions to review

1. **Backbone is ours: Agent Definition plus Engine contract.** Vendor agent SDKs are engines that execute definitions. This is what lets one registry, one policy model, one kill switch, and one telemetry stream cover every provider.
2. **Three engines from Phase 2**: native, Claude Agent SDK, OpenAI Agents SDK. The native engine must stay feature-complete; the vendor engines add depth for their own models.
3. **Local runtime is the point of execution; the control plane observes and can stop.** Connected by an outbound channel. Model traffic never transits the control plane. Halts are enforced locally at defined points and backstopped by the local proxy, with lease-based fail modes.
4. **Keys are runtime-only**, in the OS keychain. The control plane holds metadata only and never distributes keys.
5. **Discovery is gateway profile plus route catalog plus entitlement probe**, matching a gateway with a defined endpoint per model. The user supplies only the key.
6. **Local gateway proxy** presents standard provider-shaped endpoints to every engine and SDK, injects the key, meters usage, and enforces halts at the network edge (see 6.3).
7. **Sandbox level 1 by default, policy can raise the floor** (see 6.7).
8. **A sub-agent is just a child Run.** No second concept for delegation. Inheritance narrows and never widens tools, sandbox, or budget; depth and fan-out are runtime-enforced (6.8).
9. **One scheduler with per-connection limits** models the virtual key's rate limit and shares backoff across every run on that key (6.9).
10. **Orchestration in three levels, added in order**: prompt-driven delegation, handoffs, then a small declarative workflow runner. No free-form agent-to-agent chat; shared state goes through a session blackboard (6.10).
11. **Skills use the Agent Skills folder format** and are implemented once with progressive disclosure, mapped to each engine. Skills are pinned by content hash and treated as code for governance (6.11).
12. **Two entry points are two surfaces over one runtime**, not two products. A surface sets default definition, workspace, sandbox, and presentation; any definition can run on either (8.1).
13. **Escalation is a detached task with an explicit brief**, confirmed by the user by default. Tasks report back to chat by events and return a summary plus artifacts; they are not blocking sub-agents (8.2).
14. **Anthropic-shaped canonical types**, dialect and route on the Model, auth on the Connection, event-sourced runs, MCP as the tool protocol, TypeScript monorepo (unchanged from v0.1).

## 13. Open questions

1. Does the APIM API validate an Entra ID JWT in addition to the subscription key? This decides whether the runtime needs an interactive sign-in for model access.
2. Do the Anthropic-shaped routes use the standard `/v1/messages` path layout under some base, and are beta headers passed through?
3. Will the platform team publish gateway profiles, or should the rig ship a starter profile and let users export theirs?
4. Fail mode default for enrolled runtimes: `fail_open` with a grace window, or `fail_closed`?
5. Should the control plane distribute guardrail floors at all, or stay purely observe-and-halt in the first release?
6. Is a desktop shell (tray app, auto-start) wanted in the first release, or is a daemon plus browser enough?
7. Which built-in tools are must-haves for the first agent use cases?
8. Is there an existing OpenTelemetry collector or SIEM the control plane should export to from day one?
9. Should workflows (level 3 orchestration) land before the control plane, or after? The doc orders them after, on the assumption that governance of single agents matters sooner than declarative pipelines.
10. Is there an existing skill catalog or repo convention in the org the rig should import from on day one?
11. Are scheduled and webhook-triggered workflows expected on laptops (which may be asleep), or is that the first reason to add a headless execution host?
12. Is the coding workbench terminal-first (the TUI is primary, the web view secondary) or GUI-first? The doc builds both on the same API but the first one to polish is a product call.
13. Should escalation from chat default to confirming the brief every time, or auto-start for a trusted `coder` definition once the user has opted in?
14. Which IDE matters first for the extension, if any (VS Code assumed)?

## 14. First build (v1 slice)

A vertical slice that proves the risky assumptions and lets a user design, save, and run an agent. Everything else waits.

### 14.1 Definition of done

1. **Probe a model.** Pick a gateway profile (direct Anthropic and direct OpenAI ship as profiles; the APIM profile is added when its facts are known), paste a key, and see which catalog models the key is entitled to. Keys land in the OS keychain.
2. **Create an agent.** In the Agent Builder form, set name, instructions, model (explicit model or alias), tools from the built-in pack, sandbox level, budgets, and approval-required tools. Validation runs against the native engine's `supports()`.
3. **Save it.** The definition is stored in the local library as a versioned YAML file (the same format as 6.12) plus an index row in SQLite. Definitions can be exported and imported as files.
4. **Run it.** Start a session with the agent from the Chat surface or the CLI, watch it stream through the loopback proxy, see tool calls execute at sandbox level 1 with an approval prompt where configured, and see tokens and estimated cost.
5. **Replay it.** The run's events are in SQLite; the session reloads from the event log after a restart of the runtime.

Both dialects must pass steps 1 and 4: one agent on an Anthropic-dialect model and one on an OpenAI-dialect model.

### 14.2 In scope

- `packages/core`: canonical types, adapter contract, `anthropic.messages` and `openai.chat` adapters on the official SDKs, connection resolver, gateway profiles, entitlement probe, native engine, policy evaluation (allow / deny / require_approval), event log, Agent Definition schema and validation.
- `apps/runtime`: Hono local API, SQLite via Drizzle, keychain, loopback proxy (key injection and route mapping only), scheduler in its simplest form (one queue, global concurrency limit, per-run abort).
- Built-in tools: file read, file write inside the workspace, web fetch, shell at sandbox level 1. Shell and file write are approval-required by default.
- `apps/web`: three pages, Chat (with agent switcher and approval prompts), Agent Builder, Model Catalog. Plain React, streaming over SSE.
- `apps/cli`: `rig chat`, `rig agent list | create <file> | run <name> "<input>"`, `rig models probe`.

### 14.3 Out of scope for v1

Vendor engines, sub-agents and parallel spawning, skills, handoffs, workflows, the Workbench surface and TUI, escalation tasks, the control plane, telemetry export, desktop shell, `openai.responses` and `azure.openai` adapters (unless the APIM profile needs one of them on day one).

### 14.4 Build assumptions

- TypeScript, pnpm monorepo, Node 22, Hono, better-sqlite3 with Drizzle, Zod for schemas shared between runtime, web, and CLI, Vitest.
- Windows is the primary development target; keychain via DPAPI with other backends stubbed.
- The `Rig` directory becomes the repository root.
- Tested against direct provider keys first; the APIM profile and the Entra-token question are folded in as soon as a real virtual key is available.

## 15. Risks

- **Gateway policies altering requests.** APIM can strip beta headers, buffer streams, or rewrite bodies. The vendor agent SDKs are more sensitive to this than the native engine. Mitigation: Phase 0 spike and a per-connection diagnostics test.
- **Engine feature skew.** Users will expect Claude Agent SDK features on non-Claude models. Mitigation: `supports()` validation at save time and clear engine badges in the builder.
- **Runaway delegation.** Recursive or wide fan-out can burn a budget fast, especially in parallel against a rate-limited key. Mitigation: runtime-enforced depth and fan-out limits, budgets that roll up to the root, per-connection concurrency, and a halt cascade.
- **Workflow engine creep.** Declarative workflows tend to grow into a programming language. Mitigation: the fixed step-type list, no code steps, and a stated plan to adopt an existing durable-execution engine if the needs exceed the DSL.
- **Skill supply chain.** Skills carry scripts and can be imported from git. Mitigation: hash pinning, sandbox levels, source allowlists via guardrails, telemetry on load and execution.
- **Governance bypass.** A user could run the vendor SDK outside the rig. Mitigation: the rig is the sanctioned path; the gateway remains the hard control. Position the control plane as visibility plus soft enforcement, not the only enforcement.
- **Lowest-common-denominator drift** in the canonical layer. Mitigation: capability flags plus an `extensions` bag; core fields stay small.
- **Offline telemetry gaps.** Mitigation: disk-backed buffers with bounded size and oldest-first eviction, surfaced in the fleet console as "stale since".
- **Tool safety.** Mitigation: approval gates for outward-facing tools, sandbox floors by policy, egress allowlists, audit.
