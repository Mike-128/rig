import { useEffect, useState, type ReactNode } from "react";
import type { AgentSummary, PermissionMode } from "@rig/core/types";
import { api } from "../api";
import { desktop } from "../desktop";
import { MODE_HELP, MODE_LABEL } from "../components/NewSession";
import { announceSetupChange, STATUS_LABEL, useSetup, type Settings, type SetupStatus } from "../setup";
import { ModelsPage } from "./Models";
import { TeamPage } from "./Team";
import { McpPage } from "./Mcp";

export const SETTINGS_SECTIONS = [
  { id: "setup", label: "Setup" },
  { id: "models", label: "Models" },
  { id: "defaults", label: "New sessions" },
  { id: "instructions", label: "Your instructions" },
  { id: "team", label: "Team and GitHub" },
  { id: "mcp", label: "MCP servers" },
  { id: "about", label: "About" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function SettingsPage({ section }: { section: SettingsSection }) {
  const { setup } = useSetup();
  return (
    <div className="split">
      <aside className="side settings-nav" aria-label="Settings">
        <h3>Settings</h3>
        {SETTINGS_SECTIONS.map((s) => (
          <a key={s.id} className={`list-item ${section === s.id ? "active" : ""}`} href={`#/settings/${s.id}`} aria-current={section === s.id ? "page" : undefined}>
            {s.label}
            {s.id === "setup" && setup && !setup.ready && <span className="badge rate_limited nav-chip">to do</span>}
          </a>
        ))}
      </aside>
      {section === "setup" && <SetupSection setup={setup} />}
      {section === "models" && <ModelsPage />}
      {section === "defaults" && <DefaultsSection />}
      {section === "instructions" && <InstructionsSection />}
      {section === "team" && <TeamPage />}
      {section === "mcp" && <McpPage />}
      {section === "about" && <AboutSection setup={setup} />}
    </div>
  );
}

interface Step {
  title: string;
  state: "done" | "todo" | "problem" | "optional";
  detail: string;
  action?: { label: string; href: string };
}

function steps(s: SetupStatus): { required: Step[]; optional: Step[] } {
  const dm = s.defaultModel;
  const required: Step[] = [
    {
      title: "Connect a model provider",
      state: s.connections ? "done" : "todo",
      detail: s.connections
        ? `${s.connections} provider${s.connections === 1 ? "" : "s"}, ${s.entitledModels} model${s.entitledModels === 1 ? "" : "s"} passed a test.`
        : "Anthropic, OpenAI, Google, your gateway, or a local server such as Ollama. You need a key, or a server running on this machine.",
      action: { label: s.connections ? "Manage" : "Add a provider", href: "#/settings/models" },
    },
    {
      title: "Choose the default model",
      state: s.ready ? "done" : dm ? "problem" : "todo",
      detail: dm
        ? `${dm.connection} / ${dm.model}: ${STATUS_LABEL[dm.status] ?? dm.status}.${s.ready ? "" : " Pick a model that works, or fix its provider."}`
        : "The model agents use unless they ask for another. Rig picks the first working one when you connect a provider.",
      action: { label: dm ? "Change" : "Choose", href: "#/settings/models" },
    },
    {
      title: "Open a project",
      state: s.sessions ? "done" : "todo",
      detail: s.sessions ? "You have sessions. New ones start from Sessions, or Ctrl+N." : "Point an agent at a folder: it reads, searches, edits, and runs commands there, asking before it changes anything.",
      action: { label: s.sessions ? "Go to sessions" : "Open a project", href: "#/s" },
    },
  ];
  const optional: Step[] = [
    {
      title: "Your instructions",
      state: s.instructions ? "done" : "optional",
      detail: s.instructions ? "Every session reads your standing instructions." : "Standing instructions every agent reads in every project: how you like code, commits, and answers.",
      action: { label: s.instructions ? "Edit" : "Write them", href: "#/settings/instructions" },
    },
    {
      title: "Team and GitHub",
      state: s.team ? "done" : "optional",
      detail: s.team ? `Signed in as ${s.github?.login}, sharing through ${s.team}.` : s.github ? `Signed in as ${s.github.login}. Connect a team repository to share agents, skills, and memory.` : "Share agents, skills, and memory with teammates through a GitHub repository, every change reviewed.",
      action: { label: s.team ? "Open" : "Set up", href: "#/settings/team" },
    },
    {
      title: "MCP servers",
      state: s.mcp.configured ? "done" : "optional",
      detail: s.mcp.configured ? `${s.mcp.connected} of ${s.mcp.configured} server${s.mcp.configured === 1 ? "" : "s"} connected.` : "Give agents more tools: a browser, a database, your issue tracker. Same format as Claude Code.",
      action: { label: s.mcp.configured ? "Manage" : "Add servers", href: "#/settings/mcp" },
    },
    {
      title: "Skills",
      state: "optional",
      detail: `${s.skills} skill${s.skills === 1 ? "" : "s"} installed. Add more from GitHub, or use the ones in ~/.claude/skills.`,
      action: { label: "Browse", href: "#/skills" },
    },
  ];
  return { required, optional };
}

const STATE_LABEL: Record<Step["state"], string> = { done: "Done", todo: "To do", problem: "Needs attention", optional: "Optional" };

function SetupSection({ setup }: { setup: SetupStatus | null }) {
  if (!setup) return <Section title="Setup" lede="Checking what is configured…" />;
  const { required, optional } = steps(setup);
  // The first two steps decide whether an agent can run; opening a project is the first use, not a prerequisite.
  const blocking = required.slice(0, 2).filter((s) => s.state !== "done").length;
  const lede = !setup.ready
    ? `${blocking} step${blocking === 1 ? "" : "s"} before an agent can work.`
    : required[2].state === "done"
      ? "Rig is ready. Everything below is optional."
      : "Rig is ready. Open a project to start working.";
  return (
    <Section title="Setup" lede={lede}>
      <ol className="checklist">
        {required.map((s, i) => (
          <StepRow key={s.title} step={s} n={i + 1} next={s === required.find((r) => r.state !== "done")} />
        ))}
      </ol>
      <h3 className="sub-head">Make it yours</h3>
      <ol className="checklist">
        {optional.map((s) => (
          <StepRow key={s.title} step={s} />
        ))}
      </ol>
    </Section>
  );
}

/** Only the next unfinished step gets the filled button, so the page has one thing to do. */
function StepRow({ step, n, next }: { step: Step; n?: number; next?: boolean }) {
  return (
    <li className={`check check-${step.state}`}>
      <span className="check-mark" aria-hidden="true">
        {step.state === "done" ? "✓" : n ?? "+"}
      </span>
      <div className="check-body">
        <div className="check-title">
          {step.title} <span className={`badge state-${step.state}`}>{STATE_LABEL[step.state]}</span>
        </div>
        <div className="muted">{step.detail}</div>
      </div>
      {step.action && (
        <a className={`btn ${next ? "btn-primary" : ""}`} href={step.action.href}>
          {step.action.label}
        </a>
      )}
    </li>
  );
}

function DefaultsSection() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [form, setForm] = useState<Settings>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<AgentSummary[]>("/agents"), api<Settings>("/settings")])
      .then(([a, s]) => {
        setAgents(a);
        setForm(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function save() {
    setError(null);
    try {
      setForm(await api<Settings>("/settings", { method: "PUT", json: form }));
      setSaved("Saved. New sessions start this way; open ones keep their own.");
      announceSetupChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const mode = form.defaultMode ?? "default";
  const pick = (key: "projectAgent" | "chatAgent", fallback: string, label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <select value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value || undefined })}>
        <option value="">{agents.find((a) => a.slug === fallback)?.name ?? fallback} (built in)</option>
        {agents
          .filter((a) => a.slug !== fallback)
          .map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.name}
            </option>
          ))}
      </select>
      <span className="hint">{hint}</span>
    </label>
  );

  return (
    <Section title="New sessions" lede="How a new session starts. Each session can still change its agent and permissions at any time.">
      <div className="card">
        <div className="grid2">
          {pick("projectAgent", "coder", "Agent for a project folder", "Used when you open a folder.")}
          {pick("chatAgent", "assistant", "Agent for a chat", "Used when you start a chat without a folder.")}
        </div>
        <label className="field">
          <span>Permissions</span>
          <select value={mode} onChange={(e) => setForm({ ...form, defaultMode: e.target.value === "default" ? undefined : (e.target.value as PermissionMode) })}>
            {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
          <span className="hint">{MODE_HELP[mode]} Shift+Tab cycles it inside a session.</span>
        </label>
        {error && <div className="issue error">{error}</div>}
        {saved && <div className="issue ok">{saved}</div>}
        <button className="primary" onClick={save}>
          Save
        </button>
      </div>
    </Section>
  );
}

function InstructionsSection() {
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [file, setFile] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ path: string; text: string }>("/instructions")
      .then((r) => {
        setText(r.text);
        setOriginal(r.text);
        setFile(r.path);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function save() {
    setError(null);
    try {
      const r = await api<{ exists: boolean }>("/instructions", { method: "PUT", json: { text } });
      setOriginal(text);
      setMsg(r.exists ? "Saved. The next message in any session uses them." : "Cleared. No standing instructions are sent.");
      announceSetupChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Section title="Your instructions" lede="Standing instructions every agent reads, in every project. A project's own AGENTS.md, CLAUDE.md, or RIG.md is read as well, after these.">
      <div className="card">
        <label className="field">
          <span>
            Saved in <span className="mono">{file}</span>
          </span>
          <textarea className="instructions" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Examples:\nKeep answers short; skip the recap.\nRun the tests before saying a change is done.\nI work on Windows; prefer PowerShell commands."} spellCheck />
        </label>
        {error && <div className="issue error">{error}</div>}
        {msg && <div className="issue ok">{msg}</div>}
        <div className="row">
          <button className="primary" onClick={save} disabled={text === original}>
            Save
          </button>
          {text !== original && (
            <button className="ghost" onClick={() => setText(original)}>
              Discard changes
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}

function AboutSection({ setup }: { setup: SetupStatus | null }) {
  if (!setup) return <Section title="About" lede="Loading…" />;
  const keychain = setup.secrets === "os-keychain";
  return (
    <Section title="About" lede={`Rig ${setup.version}, running on this machine.`}>
      <div className="card">
        <dl className="facts">
          <dt>Data folder</dt>
          <dd>
            <span className="mono">{setup.home}</span>
            {desktop && (
              <button className="tiny" onClick={() => desktop?.openPath(setup.home)}>
                Open
              </button>
            )}
          </dd>
          <dt>Keys</dt>
          <dd>{keychain ? "In your OS keychain (Windows Credential Manager, macOS Keychain, or Secret Service)." : "In encrypted files under the data folder, because the OS keychain was not available."}</dd>
          <dt>Agents</dt>
          <dd>{setup.agents}</dd>
          <dt>Skills</dt>
          <dd>{setup.skills}</dd>
        </dl>
      </div>
      <div className="card">
        <h3>Environment variables</h3>
        <p className="muted small">Set before starting Rig.</p>
        <table>
          <tbody>
            {[
              ["RIG_HOME", "Data folder", "~/.rig"],
              ["RIG_PORT", "Runtime port", "7777"],
              ["RIG_SHELL", "Shell for the shell tool: bash, pwsh, or powershell", "auto"],
              ["RIG_HOTKEY", "Desktop show and hide shortcut", "CommandOrControl+Shift+Space"],
              ["GITHUB_TOKEN", "GitHub access for skill installs from public repositories", ""],
            ].map(([k, what, def]) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td>{what}</td>
                <td className="mono muted">{def}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Section({ title, lede, children }: { title: string; lede?: string; children?: ReactNode }) {
  return (
    <div className="content">
      <div className="scroll">
        <div className="page">
          <div className="page-head">
            <div>
              <h2>{title}</h2>
              {lede && <p className="muted">{lede}</p>}
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
