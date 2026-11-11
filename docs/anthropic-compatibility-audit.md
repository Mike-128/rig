# Anthropic and APIM compatibility audit

Checked 2026-09-30 against this checkout. This is a feature assessment, not a claim of real-gateway certification. All examples below are synthetic.

## Verdict

Rig implements the core Anthropic Messages tool loop using the official `@anthropic-ai/sdk` client. It does not implement the complete Anthropic API surface or embed the Claude Agent SDK. Consequently, it cannot yet promise the behavior or feature set of Claude Code.

A gateway backed by a Google-hosted Claude model can work with the existing adapter **if its client-facing contract is standard Anthropic Messages**, including streaming. The backend hosting provider alone does not determine compatibility.

## Checked capabilities

| Capability | Current implementation and limits |
| --- | --- |
| Official Anthropic client | `packages/core/src/adapters/anthropic.ts` uses `@anthropic-ai/sdk`; package manifest specifies `^0.80.0`. |
| Messages and streaming | Calls `client.messages.stream`; forwards text and reasoning deltas; assembles final content through the SDK. |
| Client tool calls | Sends JSON Schema tool definitions; reads `tool_use`; the native engine executes enabled local tools and returns matching `tool_result` blocks before calling the model again. |
| Multiple tool calls | Engine iterates the returned calls and groups results into one user message. Execution is sequential; the inspected mock covers single calls per response. |
| Approvals and denial | Policy gates tools; denial becomes an error result for the model. Existing Anthropic integration tests exercise approval and denial. |
| Local coding tools | File read/write and PowerShell on Windows (Bash elsewhere), when enabled on the agent. File tools operate in the session workspace. Knowledge attachments are read-only and do not turn an existing repository into a writable coding workspace. |
| Skills and memory | Rig's own skill loading, knowledge folders, and approved persistent notes. These are not automatic Claude Code project configuration loading. |
| Custom APIM routing | Connection base URL plus model route and query; model body override; configurable auth header and connection-wide metadata headers. |
| Credentials | Only the local proxy injects the real key. SDK clients use a placeholder credential and a loopback token. |
| Anthropic headers | Proxy forwards `anthropic-version` and `anthropic-beta`; configured connection headers take precedence. This alone does not enable beta request structures. |
| Thinking replay | Recognizes thinking and redacted-thinking blocks and retains native blocks/signatures for replay. Explicit thinking enablement/budgets/adaptive configuration are not exposed; only a limited effort field is sent. |
| Usage | Maps input/output and cache read/write usage. No explicit prompt-cache breakpoint configuration. |
| Recovery | Saved event history supports subsequent conversation turns. Interrupted runs do not automatically resume. |

## Gaps preventing full parity

1. **Claude Agent SDK engine is absent.** Agent schema accepts only `engine: native`. Rig owns the loop, tools, permissions, and context. Claude Code-style MCP, subagents, hooks, project configuration loading, checkpointing, and automatic context compaction are not supplied by installing the Anthropic client package.
2. **Native Google request translation is absent.** Google's documented Claude format selects the model in the URL and requires body `anthropic_version: vertex-2023-10-16`. Rig currently retains a body `model` and relies on the Anthropic version header. If APIM does not translate these formats, a compatibility layer is required. A route ending in `/v1/messages` is not sufficient evidence of its contract.
3. **Advanced API coverage is partial.** Tool choice supports only auto/none, tool results are text-only, and the adapter does not consume `CanonicalRequest.extensions`. It does not expose native server-tool definitions, document/citation blocks, strict-tool options, structured outputs, or full thinking/cache controls. Unrecognized response block types are currently dropped; these features should not be advertised as supported.
4. **The proxy is not a general Anthropic API gateway.** It admits Messages/chat calls and model listing, not all SDK endpoints such as token counting, files, or batches. A future Agent SDK integration must account for every endpoint it needs.
5. **Streaming tool-argument event IDs are inconsistent.** Anthropic `tool_use_delta` uses the content-block index as its ID, while start/end use the actual tool ID. The native engine ignores argument deltas and executes the final SDK-assembled calls, so existing execution works. Fix this before relying on live argument events in another consumer.
6. **Coverage is not complete.** The synthetic APIM suite now verifies Anthropic streaming, a custom route/query, APIM authentication, required metadata, a body-model override, and approved/denied tool-result round trips together. It does not establish access to a real gateway. Multi-call responses, thinking-signature replay, stream interruption, and new content types still need dedicated Anthropic regressions.

## Initial gateway configuration

Use these as field descriptions, not a real deployment configuration:

- Connection base URL: `https://gateway.example.com`.
- Authentication header: the header specified by the gateway owner, commonly `Ocp-Apim-Subscription-Key` for APIM.
- Key: stored through the connection key field.
- Additional headers: gateway-required non-secret metadata.
- Model dialect: `anthropic.messages`.
- Model route: the full gateway path, for example `/ai/claude/v1/messages`.
- Body model: the exact identifier accepted by the gateway. Do not infer it from the display name.
- Query parameters: only those required by the documented gateway contract. Do not reuse Azure OpenAI API-version settings automatically.

Confirm whether the gateway accepts standard Anthropic JSON (`model`, `max_tokens`, `messages`, `tools`, `stream`) and translates to its backend, or requires the native Google format. Also confirm required headers, accepted model identifiers, streaming support, and supported thinking options. A redacted working request and response are enough to resolve this; credentials are not needed for code review.

## Recommended implementation and acceptance sequence

1. **Implemented:** a synthetic APIM/Anthropic integration fixture enforcing a custom route, subscription-key header, required metadata, version header, and body-model override. `apps/runtime/test/anthropic-apim.test.ts` exercises the complete stream -> local tool -> result -> final response cycle, including denial. It also verifies that a validation-only probe does not establish successful inference.
2. Add regressions for multiple calls, tool failure/denial, signed thinking replay, cancellation, malformed/truncated streams, and rate-limit/server errors. Correct argument-delta IDs and make unsupported content behavior explicit.
3. Implement only the gateway translation confirmed by its contract. Preserve authentication on the connection and protocol/route on the model. Do not put private gateway details in fixtures or public documentation.
4. Run a live acceptance test on the authorized machine: read a synthetic workspace file, approve a write to a disposable file, run a harmless command, deny another operation, then verify a follow-up answer and cancellation. Confirm both streamed inference requests contain required metadata. A validation-only 400 probe is not successful inference.
5. For the specific goal of using Claude Code's underlying capabilities, implement the separately designed Claude Agent SDK engine. Validate its proxy endpoint needs, event mapping, permissions, session lifecycle, and Windows installation requirements before claiming parity. Keep the native engine available for provider-agnostic agents.

## Verification performed

- Direct Vitest run of end-to-end, skills, and connection settings suites: **24 passed**.
- Full direct Vitest run: **90 passed; 1 CLI subprocess test failed** during Windows `os.userInfo` lookup (`uv_os_get_passwd` / `ENOMEM`) in the restricted environment.
- Reran the CLI suite outside that restriction: **11 passed**, including the previously failing case. Thus all 91 existing tests passed across these runs; the original full run was not uniformly green.
- The pnpm launcher initially attempted dependency reconciliation and failed on restricted registry access/no TTY. Tests above used the already-installed Vitest directly; no dependency upgrade was performed.
- No real APIM/Google requests were made. No production code was changed as part of this audit.

### Standard Messages compatibility follow-up

The working assumption for the planned deployment is that APIM exposes standard Anthropic Messages and handles any backend translation. No native Google request transformation was added.

Added three synthetic gateway regression cases; all passed. The new suite plus existing end-to-end and skills suites passed **20 tests** together. The assertions verify that the real APIM test key replaces the SDK placeholder, the loopback token is absent upstream, `anthropic-version` is forwarded, no native Google `anthropic_version` body field is introduced, and the SDK correctly reconstructs fragmented tool arguments before local execution.

Run just the new suite using the installed dependencies from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run apps/runtime/test/anthropic-apim.test.ts
```

These tests require no API key, external network, or provider usage. The final acceptance step remains a real streamed tool round trip on the authorized machine.

## Primary references

- [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview): client-side tool execution and result exchange.
- [Claude on Google Cloud](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai): native request-format differences.
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview): distinction between the API client and the Claude Code agent runtime.
