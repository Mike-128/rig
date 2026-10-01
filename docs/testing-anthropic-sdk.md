# Testing the Anthropic SDK through APIM

This guide tests Rig's official Anthropic client SDK integration: standard Messages requests, streamed responses, and local tool execution through an Azure API Management gateway. It assumes APIM exposes the **Anthropic Messages format**, even if the model is hosted on another cloud platform. Backend translation is the gateway's responsibility under this contract.

Rig uses its own native agent loop. This test does not establish full Claude Code or Claude Agent SDK feature parity. See the [compatibility audit](anthropic-compatibility-audit.md) for current limits.

All hosts, routes, model names, and metadata values below are fictional. Obtain the actual values from your gateway administrator. Keep private settings and credentials out of Git.

## 1. Start the runtime

Install dependencies first using the [Windows setup guide](windows-setup.md). In a normal PowerShell terminal at the repository root, run each command separately:

```powershell
$env:Path = "$env:LOCALAPPDATA\rig-tools;$env:Path"
pnpm.cmd build
pnpm.cmd rig serve
```

The PATH line is for the user-local installation described in that guide. Apply any approved corporate CA settings in this same terminal **before** starting the runtime. Stop an existing runtime with Ctrl+C before restarting. Keep the same account and `RIG_HOME` to retain saved connections and agents.

Open [http://127.0.0.1:7777](http://127.0.0.1:7777). The built UI does not require Vite. If using Vite on port 5173, the runtime must still run separately. From a second terminal, `pnpm.cmd rig doctor` checks runtime health; it does not establish provider tool compatibility.

## 2. Configure the connection in Models

| Connection field | Setting |
| --- | --- |
| Gateway profile | **Azure API Management gateway (template)** |
| Connection name | A recognizable local name, such as `claude-apim-test` |
| Key | Your APIM subscription key, entered only in this field |
| Base URL override | Gateway origin, for example `https://gateway.example.com` |
| Auth header override | Your gateway's documented header; commonly `Ocp-Apim-Subscription-Key` |
| Additional request headers | Required non-secret metadata as header/value rows, for example `x-project-code` / `demo-project` |

Click **Add and probe**. The template's sample model routes may fail; configure your actual model in the next step. Use **Connection settings** to edit metadata headers on an existing connection. These values are visible in settings and are not secret storage.

The SDK sends `anthropic-version: 2023-06-01`; Rig forwards it through the proxy. Do not put the APIM key into an additional header, agent instruction, or model query field. Do not add a native Google `anthropic_version` body field for a standard Messages endpoint.

## 3. Add the Claude model manually

On the connection card, select **Add model manually**:

| Model field | Setting |
| --- | --- |
| Model ID | Exact model identifier accepted by the gateway, or a stable local ID such as `claude-test` if using the body override below |
| Display name | Optional friendly label, such as `Claude gateway test` |
| Dialect | **`anthropic.messages`** |
| Route (path appended to base URL) | Full gateway path, for example `/ai/platform/claude/v1/messages` |
| Body model override | Exact identifier expected in the request's `model` field; leave blank only when Model ID already matches it |
| Query parameters (JSON string values) | **`{}`** unless your gateway explicitly requires query parameters |
| Max tokens field (OpenAI dialect) | Not used for Anthropic; the adapter sends `max_tokens` |
| Supports reasoning effort | Leave unchecked for this baseline test; enable only with confirmed model/gateway support |

With the example values, the request URL is:

```text
https://gateway.example.com/ai/platform/claude/v1/messages
```

Enter the hostname in **Base URL** and the path in **Route** once each. Do not put the full Messages URL in both fields. Do not copy an Azure OpenAI `api-version` into a Claude configuration unless your gateway explicitly requires it. If it does require query values, use an object of strings, for example `{"revision":"approved-value"}`.

Click **Add model**, then the model row's **probe** button. Existing manual models have **Edit**; their saved IDs remain fixed, while route and body model can change.

Read the probe detail, not just its badge. Rig currently treats HTTP 400 validation responses as entitled. That indicates the request reached a validation boundary; it does **not** prove that streaming or tools work. Inventory scanning is optional and is not required to use a manually configured model.

## 4. Create a dedicated test agent

In **Agents**, create and save an agent with these settings:

| Setting | Value |
| --- | --- |
| Name | `Anthropic compatibility test` |
| Model binding | Select your connection and manually configured Claude model explicitly |
| Tools | `file_read`, `file_write`, `shell` |
| Require approval before running | `file_write`, `shell` |
| Sandbox level | `1` (writes and process execution permitted by policy) |
| Maximum turns | `10` |
| Maximum output tokens | `4096`, or a lower limit required by your model |
| Temperature / reasoning effort | Leave unset for the baseline |

Use these instructions:

```text
You are testing the harness's Anthropic tool integration. Use the requested
tools and report their actual results. Work only on the named synthetic test
files in the session workspace. Do not claim an operation succeeded unless
the tool result confirms it. Respect denied approvals and do not retry them
through another tool.
```

Validate and save. Start a **new Chat session** with this agent; existing sessions retain their pinned agent version. Explicit model binding avoids accidentally testing another model through the default alias. The default Assistant does not have all three test tools enabled.

## 5. Run the live acceptance check

These steps send real model requests and may incur usage. Use a fresh session workspace containing no important files. Submit each prompt separately and inspect the tool entries and approval requests.

1. **Text and streaming:** `Reply with a short explanation of what you can do in this test.` Confirm a completed answer and streamed text when the response is long enough to observe it.
2. **Write, then read:** `Use file_write to create anthropic-sdk-test.txt containing exactly RIG_ANTHROPIC_OK_731. Then use file_read to read that file and report its exact contents.` Review and approve only the expected write. Confirm successful write/read tool results and the final answer containing the marker. This checks tool execution followed by additional Messages requests.
3. **Shell on Windows:** `Use shell to run Write-Output 'RIG_SHELL_OK_731'. Report the result.` Approve that harmless command. Confirm its output and exit code 0. On macOS/Linux, use `printf 'RIG_SHELL_OK_731\n'` instead.
4. **Denial:** `Use file_write to create anthropic-denial-test.txt containing DENIAL_TEST.` Deny the approval. Confirm the agent acknowledges the denial. Ask it to use `file_read` to list `.` and verify the file was not created; it must not retry through shell.
5. **Follow-up context:** Ask `What exact marker did you read from anthropic-sdk-test.txt?` Confirm the response matches the earlier tool result.

Pass means actual successful tool results, correct follow-up responses, and respected approval decisions. A green probe, a model's claim that it used a tool, or a text-only response is insufficient. Record failures separately: tool selection, approval, local execution, or the follow-up provider request.

If the model does not choose a requested tool, check the saved agent's tools, explicit model binding, and whether this is a new session. Model behavior is not deterministic; the synthetic regression below separately checks the protocol with deterministic responses.

## Automated compatibility test (no provider key)

From the repository root with dependencies installed:

```powershell
node node_modules/vitest/vitest.mjs run apps/runtime/test/anthropic-apim.test.ts
```

This starts disposable local servers and runtime state. It does not use your saved connection or call an external provider. The tests check:

- Custom route/query and body-model override.
- APIM subscription authentication, required metadata, and the Anthropic version header on both inference requests.
- Absence of the SDK placeholder key and loopback proxy token upstream.
- Standard Anthropic JSON, streaming, and reconstruction of fragmented tool arguments.
- Approved and denied tool-result round trips followed by a final response.
- Visible inference failure for missing metadata, even when a validation-only probe is classified as entitled.

This establishes the tested standard Messages contract. A live test is still needed for your gateway's network access, TLS, permissions, SSE handling, and model configuration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| 401 / 403 | Subscription key, auth header, model access, and gateway/network policy. |
| 404 | Base URL + route, exact body-model identifier, and documented query parameters. Do not guess deployment names. |
| 400 missing header | Add the required metadata in connection settings, then retry. |
| Other 400 | Read the validation detail; check model ID, token limit, version requirements, and optional parameters. |
| 502 / issuer certificate error | Check runtime connectivity and approved CA trust. Settings applied only to Vite or a second terminal do not affect an already running runtime. |
| Probe succeeds but chat fails | The probe is non-streaming and may accept validation failures. Test an actual chat and inspect its error. |
| Text works but tool follow-up fails | Verify that APIM accepts `tools`, preserves `tool_use` / `tool_result`, and forwards standard Anthropic SSE events. |
| UI appears stalled | Check the runtime terminal and pending approvals; investigate gateway streaming buffering/timeouts. |

When reporting a result, include the failed step, HTTP status, relevant redacted error, Rig revision (`git rev-parse --short HEAD`), and whether the automated test passed. Do not publish subscription keys, private hosts, metadata values, or private model inventories.
