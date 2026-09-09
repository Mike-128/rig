# Rig

Rig is a provider-agnostic agent harness. Register model keys (direct provider, gateway virtual key, or local server), see which models a key is entitled to, then design, save, and run agents against any of them. Design notes are in [DESIGN.md](DESIGN.md); orientation for coding agents is in [AGENTS.md](AGENTS.md).

This is the v1 slice: local runtime, loopback proxy, native engine, two dialects (Anthropic Messages and OpenAI Chat Completions), skills, a conversational agent builder, a web UI with Chat / Agents / Skills / Models, and a CLI.

## Layout

```
packages/core     canonical types, adapters, gateway profiles, native engine, built-in tools
apps/runtime      local daemon: API, loopback proxy, SQLite event log, keychain, scheduler
apps/web          React UI (Chat, Agents, Skills, Model Catalog)
apps/cli          rig CLI (serve, models, connections, alias, agent, chat)
apps/runtime/skills  bundled skills shipped with the app
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
2. **Agents**: the default `assistant` uses the `default` alias. Create your own: instructions, model (alias or explicit), tools, approvals, sandbox level, budgets. Save creates a versioned YAML under `~/.rig/agents`.
3. **Chat**: start a session with an agent and talk to it. Tool calls show inline; approval-gated tools pause the run until you approve or deny.

## Building agents by chatting

Open **Chat** and click *Describe an agent in chat*. That starts a session with the seeded `agent-builder`, which you talk to in plain language:

> Create an agent that reviews Terraform files for security problems and writes its findings to a markdown report.

The builder looks at which models your keys actually reach, consults the bundled `agent-design` skill, proposes the agent in a few lines, then writes it. Because `agent_write` is approval-gated, you see the exact definition and approve it before anything is saved. The new agent then appears in the agent list, ready to run.

The builder is an ordinary agent — its power comes entirely from its tools (`agent_write`, `model_list`, `skill_list`, and friends). Any agent you create can be given the same tools, so agents that manage other agents are just a configuration choice. Grant them in the Agent Builder form under *Rig management tools*.

## Skills

A skill is a folder holding `SKILL.md`: YAML frontmatter with a `name` and `description`, then markdown instructions. Only the description sits in an agent's context; the agent calls `load_skill` to read the body when a task matches. That keeps dozens of skills affordable.

Two skills ship bundled, and the agent builder uses both: `agent-design` and `skill-authoring`. Manage skills in the **Skills** page, or drop folders into `~/.rig/skills/<name>/SKILL.md`. A user skill shadows a bundled one of the same name, so you can fork the defaults without losing them.

Attach skills to an agent in the Agent Builder; `load_skill` is added automatically.

## CLI

Check a restricted work laptop from an ordinary terminal (no administrator mode required):

```bash
pnpm rig doctor --offline
pnpm rig doctor --workspace "C:\path\to\repository"
pnpm rig doctor --json
pnpm rig doctor --probe
```

On Windows, use `pnpm.cmd` if PowerShell blocks the `pnpm.ps1` launcher; this does not change execution policy. `doctor` checks Node, in-memory SQLite, temporary writes in the workspace and data directory, a harmless command in Rig's shell, and proxy/CA environment configuration. Temporary files are removed; a missing data directory is checked through its nearest existing parent without creating it. It does not install software, change certificates, request elevation, or open the credential store directly.

By default it also reads the running daemon's health and model catalog at `RIG_URL` (default `http://127.0.0.1:7777`). Start `rig serve` first, or use `--offline` to skip all HTTP checks. A healthy endpoint confirms the runtime is reachable, not that every loopback port is usable. Environment checks describe the CLI process; a separately started runtime may have different settings.

`--probe` explicitly makes a minimal provider request for the **default alias only**, through the runtime, and updates saved entitlement. It may incur provider usage. A passing probe includes provider validation responses, so it does not prove successful streaming or tool execution. Use Models for detailed probe failures. `--offline` and `--probe` cannot be combined.

`--timeout <seconds>` bounds each shell/runtime check (default 5, range 1–120); the provider probe has a minimum client deadline of 35 seconds to allow the runtime's 30-second probe. Exit code 1 means a required check failed; 0 means none failed, even if warnings remain. `--json` emits a versioned report with `checks` and `exitCode`; reports omit paths, keys, proxy values, and raw provider errors. A missing shell is a warning because read-only agents remain usable. SQLite may emit Node's experimental-feature warning on stderr.

```bash
pnpm rig models profiles
pnpm rig connections add --name gemini --profile google-gemini --key-env GEMINI_API_KEY
pnpm rig models list
pnpm rig alias set default gemini gemini-2.5-flash
pnpm rig agent create examples/coder.yaml
pnpm rig chat --agent agent-builder
pnpm rig agent run coder "List the files in this workspace" --workspace .
pnpm rig chat --agent assistant
```

Set `RIG_HOME` to relocate the data directory (default `~/.rig`) and `RIG_PORT` to change the runtime port (default 7777).

## Where keys live

Keys go into the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) under the service name `rig`. If the keychain is unavailable the runtime falls back to AES-encrypted files under `~/.rig/secrets` and says so at startup. Engines never see keys: every model call goes through a loopback proxy on the runtime that injects the key and maps the standard provider path onto the gateway route.

## Tests

```bash
pnpm test
```

The runtime test suite starts a mock upstream that speaks both dialects and walks the v1 definition of done end to end: probe, create, save, run with a tool call and an approval, restart, replay.

## License

MIT. See [LICENSE](LICENSE).
