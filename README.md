# Rig

Rig is a provider-agnostic agent harness and desktop companion. Register model keys (a provider directly, a gateway virtual key, or a local server), see which models a key can reach, then work with agents on your own projects: open a folder and the Coder agent reads, searches, edits, runs commands, and delegates to sub-agents, asking before it changes anything. Design notes are in [DESIGN.md](DESIGN.md); orientation for coding agents is in [AGENTS.md](AGENTS.md).

## Layout

```
packages/core        canonical types, adapters, gateway profiles, the agent engine, built-in tools
apps/runtime         local daemon: API, loopback proxy, SQLite event log, keychain, scheduler, MCP
apps/web             React UI: Sessions (the workbench), Agents, Skills, Memory, Team, MCP, Models
apps/desktop         Electron shell: window, tray, global hotkey, notifications, folder picker
apps/cli             rig CLI
apps/runtime/skills  bundled skills
examples/            example agent definitions
```

## Run it

Requires Node 22.13 or newer (SQLite is built in) and pnpm.

```bash
pnpm install
```

The desktop app builds the UI, starts the runtime, and lives in the tray:

```bash
pnpm desktop
```

Or run it in a browser at http://localhost:7777:

```bash
pnpm start
```

To try it without any keys, the demo runs everything against a scripted mock model in a throwaway folder (http://localhost:7790):

```bash
pnpm --filter @rig/runtime demo
```

If `pnpm desktop` says Electron failed to install, run `pnpm --filter @rig/desktop electron:install` once.

## First steps

1. **Models.** Pick a gateway profile (Anthropic, OpenAI, Google Gemini, an OpenAI-compatible local server, or the APIM template), paste the key, and click *Add and probe*. Entitled models get a green badge. Click *set as default* on one.
2. **Open a project.** In **Sessions**, click *Open a project…* and choose a folder. The session runs the Coder agent there.
3. **Work.** Describe the task. Coder plans multi-step work as a visible task list, reads and searches the code, shows each edit as a diff, and streams command output as it runs.

## The workbench

| | |
|---|---|
| Enter | Send. While the agent is working, the message steers it: it arrives at the agent's next step. |
| Esc | Stop the agent. |
| Shift+Tab | Cycle permissions: ask before changes · accept edits · plan only · auto. |
| `/` | Commands (`/clear`, `/compact`, `/mode`, `/agent`, `/help`) and skills. |
| `@` | Mention a file; its contents go with the message. |
| Enter / A / Esc | Allow · always allow · deny, when the agent asks. |
| Ctrl+N, Ctrl+B | New session, toggle the sidebar. In the desktop app, Ctrl+Shift+Space shows or hides Rig from anywhere. |

**Permissions.** *Ask before changes* asks before every file edit and command. *Accept edits* lets edits through and still asks before commands. *Plan only* blocks anything that changes things, so the agent investigates and proposes. *Auto* runs everything the agent is allowed to use. *Always allow* on a prompt stops asking for that tool, or for that command (`npm test`, `git status`) in shell's case. A chained command never matches a rule.

**Project instructions.** `AGENTS.md`, `CLAUDE.md`, and `RIG.md` in the project folder go into the agent's instructions, so a project set up for Claude Code works unchanged. `~/.rig/RIG.md` holds your own standing instructions for every project.

**Long sessions** compact automatically as the context fills: the conversation is summarized and the agent continues from the summary. `/compact` does it on demand.

**The desktop app** keeps running in the tray when you close the window, so agents keep working. When one needs approval or finishes while Rig is in the background, you get a notification, and clicking it opens that session.

## Agents

The seeded agents are **Coder** (software engineering in a project folder), **Assistant** (general chat), and **Agent Builder**. Create your own in **Agents**: instructions, model (an alias or an explicit model), tools, approvals, sandbox level, and budgets. Saving creates a versioned YAML file under `~/.rig/agents`.

Tools: `file_read`, `glob`, `grep`, `file_edit`, `file_write`, `shell`, `web_fetch`, `todo_write`, `task` (sub-agents), `load_skill`, the rig management tools, and MCP tools. Read-only calls in one turn run in parallel. On Windows, `shell` uses Git Bash when it is installed, then PowerShell 7, then Windows PowerShell; set `RIG_SHELL` to choose.

### Building agents by chatting

Start a session with **Agent Builder** and describe what you want:

> Create an agent that reviews Terraform files for security problems and writes its findings to a markdown report.

The builder checks which models your keys reach, consults the `agent-design` skill, proposes the agent, and writes it once you approve. It is an ordinary agent whose power comes from its tools, so any agent can be given the same ability.

## Skills

A skill is a folder holding `SKILL.md`: YAML frontmatter with a `name` and `description`, then markdown instructions, plus any scripts or reference files. Only descriptions sit in an agent's context; it loads a skill's body when a task matches.

Rig finds skills in four places, and on a name clash the more specific wins:

| Source | Location |
|---|---|
| Project | `.rig/skills/` or `.claude/skills/` in the project folder |
| Yours | `~/.rig/skills/`, including skills installed from GitHub |
| Claude Code | `~/.claude/skills/`, so your Claude Code skills work as they are |
| Bundled | shipped with Rig |

**From GitHub:** in **Skills**, click *Install from GitHub* and paste a repository, a folder in one, or a `SKILL.md` link, such as `https://github.com/anthropics/skills`. Pick the skills to install. Each remembers where it came from, so *Update from GitHub* pulls the latest. Set `GITHUB_TOKEN` for the runtime for private repositories or higher rate limits.

**Use them:** type `/name` in a session to run a skill directly, attach skills to an agent, or give an agent every skill with `skills: ["*"]` (Coder has this).

## Memory

Agents with `memory_read` and `memory_write` (Coder has both) keep short notes between sessions: decisions and why, conventions, gotchas, preferences. One fact per file, each with a one-line description; the descriptions sit in every session's prompt and the agent reads a note when it is relevant. **Personal** memory lives in `~/.rig/memory` and is saved directly. **Team** memory lives in the team repo and changes only through a reviewed pull request. Manage both on the **Memory** page.

## Team

A small team shares agents, skills, and memory through a GitHub repository. Everyone keeps their own keys and models; agents bind to aliases such as `default`, which each person maps to a model on their own machine.

1. **Create a private repository** for the team, and protect its default branch: require a pull request review before merging. Rig warns if the branch is unprotected. A `CODEOWNERS` file can route agent and memory changes to specific reviewers.
2. **Sign in** on the **Team** page. Rig acts as you on GitHub, and works with Enterprise Managed Users on github.com or on a data-residency host such as `acme.ghe.com`:
   - **GitHub CLI** (recommended): run `gh auth login --hostname <host>` once, then click *Use gh sign-in*.
   - **Token**: a fine-grained token for the team repo with Contents and Pull requests set to read and write.
   - **Browser sign-in**: needs the client ID of an OAuth app your enterprise has approved.
3. **Connect the repository** (`owner/name` or its URL). The first person sets up an empty repo with one click.
4. **Share.** *Share with team* on an agent or skill, a team memory on the Memory page, or an agent's own `memory_write` to the team: each queues a change. *Open pull request* on the Team page turns the queue into one branch, commit, and pull request in your name. Personal skills an agent uses go with it.
5. **Review on GitHub.** Teammates review and merge as they would any pull request. Rig shows each pull request's review state, and everyone picks up merged changes at startup, every five minutes, or with *Sync now*.

Team agents are read-only on each machine: editing one proposes a change instead of saving it. A personal agent with the same slug shadows the team's, so you can try changes before proposing them.

The repository holds definitions, not deliverables. Rig reads and writes only `agents/`, `skills/`, `memory/`, `README.md`, and `rig-team.json`, with size limits (memory notes up to 8,000 characters, files up to 1 MB, skills up to 5 MB), and agents have no way to write anything else into it. Rig never pushes to the default branch.

## MCP

Rig connects to Model Context Protocol servers and offers their tools to agents. In the **MCP** page, edit `~/.rig/mcp.json`. It uses the same `mcpServers` format as Claude Code, so entries can be pasted across:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/projects"] },
    "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }
  }
}
```

An agent gets MCP tools by listing `mcp__*` (every server; Coder has this), `mcp__<server>__*`, or a single tool. Tools a server marks read-only run freely; the rest ask for approval unless the session's mode allows them. A project's own `.mcp.json` is not loaded automatically, because it can run arbitrary commands.

## CLI

```bash
pnpm rig models profiles
pnpm rig connections add --name gemini --profile google-gemini --key-env GEMINI_API_KEY
pnpm rig models list
pnpm rig alias set default gemini gemini-2.5-flash
pnpm rig agent run coder "List the files in this workspace" --workspace .
pnpm rig chat --agent assistant
```

| Variable | Default | |
|---|---|---|
| `RIG_HOME` | `~/.rig` | Data directory |
| `RIG_PORT` | `7777` | Runtime port |
| `RIG_SHELL` | auto | `bash`, `pwsh`, or `powershell` for the shell tool |
| `RIG_HOTKEY` | `CommandOrControl+Shift+Space` | Desktop show/hide hotkey |
| `GITHUB_TOKEN` | | GitHub access for skill installs from public repos (the team sign-in is separate) |

## Where keys live

Keys go into the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) under the service name `rig`. If the keychain is unavailable, the runtime falls back to AES-encrypted files under `~/.rig/secrets` and says so at startup. Agents never see keys: every model call goes through a loopback proxy in the runtime, which injects the key and maps the standard provider path onto the gateway route.

## Tests

```bash
pnpm test
```

The tests use a mock upstream that speaks both dialects, so no keys are needed. They cover the tools, permission modes and rules, the parallel and steerable engine, compaction, the full runtime flow (probe, create, run with approvals, restart, replay), skills from GitHub, a real MCP server over stdio, and two teammates sharing through a mock GitHub: share, review, merge, sync, and run.

The demo includes a mock GitHub for the Team page: paste the token `demo-github-token` and connect `acme/rig-team`. It prints how to approve and merge pull requests as the reviewing teammate.

## License

MIT. See [LICENSE](LICENSE).
