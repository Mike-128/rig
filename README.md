# Harness

A provider-agnostic agent harness. Register model keys (direct provider, gateway virtual key, or local server), see which models a key is entitled to, then design, save, and run agents against any of them. Design notes are in [DESIGN.md](DESIGN.md).

This is the v1 slice: local runtime, loopback proxy, native engine, two dialects (Anthropic Messages and OpenAI Chat Completions), a web UI with Chat / Agents / Models, and a CLI.

## Layout

```
packages/core     canonical types, adapters, gateway profiles, native engine, built-in tools
apps/runtime      local daemon: API, loopback proxy, SQLite event log, keychain, scheduler
apps/web          React UI (Chat, Agents, Model Catalog)
apps/cli          harness CLI (serve, models, connections, alias, agent, chat)
examples/         example agent definitions
```

## Run it

Requires Node 22.13 or newer (SQLite is built in) and pnpm.

```bash
pnpm install
```

Start the runtime and the web UI in two terminals (or `pnpm dev` for both):

```bash
pnpm dev:runtime
```

```bash
pnpm dev:web
```

Open http://localhost:5173.

1. **Models**: pick a gateway profile (Anthropic, OpenAI, Google Gemini via its OpenAI-compatible endpoint, an OpenAI-compatible local server, or the APIM template), paste the key, and click *Add and probe*. Entitled models get a green badge. Click *set as default* on one.
2. **Agents**: the default `assistant` uses the `default` alias. Create your own: instructions, model (alias or explicit), tools, approvals, sandbox level, budgets. Save creates a versioned YAML under `~/.harness/agents`.
3. **Chat**: start a session with an agent and talk to it. Tool calls show inline; approval-gated tools pause the run until you approve or deny.

## CLI

```bash
pnpm harness models profiles
pnpm harness connections add --name gemini --profile google-gemini --key-env GEMINI_API_KEY
pnpm harness models list
pnpm harness alias set default gemini gemini-2.5-flash
pnpm harness agent create examples/coder.yaml
pnpm harness agent run coder "List the files in this workspace" --workspace .
pnpm harness chat --agent assistant
```

Set `HARNESS_HOME` to relocate the data directory (default `~/.harness`) and `HARNESS_PORT` to change the runtime port (default 7777).

## Where keys live

Keys go into the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) under the service name `harness`. If the keychain is unavailable the runtime falls back to AES-encrypted files under `~/.harness/secrets` and says so at startup. Engines never see keys: every model call goes through a loopback proxy on the runtime that injects the key and maps the standard provider path onto the gateway route.

## Tests

```bash
pnpm test
```

The runtime test suite starts a mock upstream that speaks both dialects and walks the v1 definition of done end to end: probe, create, save, run with a tool call and an approval, restart, replay.
