import type { AgentSummary } from "@rig/core/types";
import { SIDE_EFFECT_TOOLS } from "@rig/core/agent";
import type { McpServerStatus } from "../pages/Mcp";

interface ToolInfo {
  name: string;
  label: string;
  help: string;
}

interface ToolGroup {
  title: string;
  tools: ToolInfo[];
  /** Shown folded, for tools most agents should not have. */
  advanced?: boolean;
}

/** The tools an agent can be given, grouped by what they are for, in plain words. */
export const TOOL_GROUPS: ToolGroup[] = [
  {
    title: "Files",
    tools: [
      { name: "file_read", label: "Read files", help: "Read files and list folders in the workspace." },
      { name: "glob", label: "Find files", help: "Find files by name pattern." },
      { name: "grep", label: "Search in files", help: "Search file contents for text or a pattern." },
      { name: "file_edit", label: "Edit files", help: "Change existing files by exact replacement." },
      { name: "file_write", label: "Write files", help: "Create files or replace their contents." },
      { name: "document_create", label: "Create documents", help: "Word, web page, Markdown, or CSV files for you to download. Never overwrites." },
    ],
  },
  {
    title: "Web and commands",
    tools: [
      { name: "web_fetch", label: "Fetch web pages", help: "Read a public web page as text." },
      { name: "shell", label: "Run commands", help: "Run commands in the workspace folder. The widest capability here." },
    ],
  },
  {
    title: "Planning and teamwork",
    tools: [
      { name: "todo_write", label: "Keep a task list", help: "Show a step-by-step plan while it works." },
      { name: "task", label: "Delegate tasks", help: "Hand one-off work to a helper that reports back once." },
      { name: "agent_message", label: "Talk to other agents", help: "Hold saved conversations with other agents: ask, answer their questions, follow up." },
      { name: "load_skill", label: "Use skills", help: "Read the full instructions of an attached skill. Added when you attach one." },
    ],
  },
  {
    title: "Knowledge and memory",
    tools: [
      { name: "knowledge_read", label: "Read knowledge folders", help: "Browse and read the knowledge folders attached above." },
      { name: "knowledge_search", label: "Search knowledge folders", help: "Search the attached knowledge folders for text." },
      { name: "memory_read", label: "Read memory", help: "Read personal and team memory, and this agent's notes." },
      { name: "memory_write", label: "Save memory", help: "Save memory for future sessions. Always asks first." },
    ],
  },
  {
    title: "Manage Rig",
    advanced: true,
    tools: [
      { name: "agent_list", label: "List agents", help: "See the agents saved in Rig." },
      { name: "agent_read", label: "Read agents", help: "Read another agent's definition." },
      { name: "agent_write", label: "Create and edit agents", help: "Save new or changed agents." },
      { name: "model_list", label: "List models", help: "See which models Rig can reach." },
      { name: "skill_list", label: "List skills", help: "See the installed skills." },
      { name: "skill_write", label: "Create and edit skills", help: "Save new or changed skills." },
    ],
  },
];

/** Tools that change things, so they cannot run when the agent is read-only. */
const NEEDS_WRITE = new Set(["file_write", "file_edit", "shell", "memory_write"]);
/** Tools that must always ask first. */
const ALWAYS_ASKS = new Set(["memory_write"]);
const SIDE_EFFECTS = new Set<string>(SIDE_EFFECT_TOOLS);

export interface ToolPickerValue {
  tools: string[];
  approvals: string[];
  talksTo: string[];
}

export function ToolPicker({
  value,
  readOnly,
  slug,
  agents,
  mcpServers,
  onChange,
}: {
  value: ToolPickerValue;
  /** The agent's access is read-only (sandbox 0). */
  readOnly: boolean;
  slug: string;
  agents: AgentSummary[];
  mcpServers: McpServerStatus[];
  onChange: (next: ToolPickerValue) => void;
}) {
  const { tools, approvals, talksTo } = value;
  const has = (t: string) => tools.includes(t);

  // Turning a tool on asks first by default when it changes things; turning it off drops its approval.
  const setTool = (t: string, on: boolean) =>
    onChange({
      ...value,
      tools: on ? [...new Set([...tools, t])] : tools.filter((x) => x !== t),
      approvals: on ? (SIDE_EFFECTS.has(t) ? [...new Set([...approvals, t])] : approvals) : approvals.filter((x) => x !== t),
    });
  const setAsk = (t: string, ask: boolean) => onChange({ ...value, approvals: ask ? [...new Set([...approvals, t])] : approvals.filter((x) => x !== t) });
  const togglePartner = (s: string) => onChange({ ...value, talksTo: talksTo.includes(s) ? talksTo.filter((x) => x !== s) : [...talksTo, s] });

  const row = (t: ToolInfo) => {
    const on = has(t.name);
    const blocked = readOnly && NEEDS_WRITE.has(t.name);
    const asks = approvals.includes(t.name);
    const id = `tool-${t.name}`;
    return (
      <div key={t.name} className={`tool-row ${on ? "on" : ""} ${blocked ? "blocked" : ""}`}>
        <input id={id} type="checkbox" checked={on} disabled={blocked && !on} onChange={(e) => setTool(t.name, e.target.checked)} />
        <label htmlFor={id} className="tool-text">
          <span className="tool-label">{t.label}</span>
          <span className="tool-help">
            {t.help}
            {blocked && <span className="tool-warn"> Needs write access, below.</span>}
          </span>
        </label>
        {on && t.name !== "load_skill" && (
          <label className={`ask ${asks ? "asks" : ""}`} title={asks ? "Asks you before each use" : SIDE_EFFECTS.has(t.name) ? "Runs without asking, though it changes things" : "Runs without asking"}>
            <input type="checkbox" checked={asks || ALWAYS_ASKS.has(t.name)} disabled={ALWAYS_ASKS.has(t.name)} onChange={(e) => setAsk(t.name, e.target.checked)} />
            {asks || ALWAYS_ASKS.has(t.name) ? "Asks first" : SIDE_EFFECTS.has(t.name) ? <span className="tool-warn">Runs freely</span> : "Runs freely"}
          </label>
        )}
        {on && t.name === "agent_message" && (
          <div className="partners">
            <span className="tool-help">Can talk to {talksTo.length ? "these agents:" : "any agent. Pick some to limit it:"}</span>
            <div className="chips">
              {agents
                .filter((a) => a.slug !== slug)
                .map((a) => (
                  <button key={a.slug} type="button" className={`chip ${talksTo.includes(a.slug) ? "on" : ""}`} aria-pressed={talksTo.includes(a.slug)} title={a.description} onClick={() => togglePartner(a.slug)}>
                    {a.name}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const group = (g: ToolGroup) => {
    const count = g.tools.filter((t) => has(t.name)).length;
    const body = <div className="tool-rows">{g.tools.map(row)}</div>;
    return g.advanced ? (
      <details key={g.title} className="tool-group" open={count > 0}>
        <summary>
          <span className="tool-group-title">{g.title}</span>
          <span className="muted small"> {count ? `${count} on` : "for agents that build agents and skills"}</span>
        </summary>
        {body}
      </details>
    ) : (
      <section key={g.title} className="tool-group">
        <h4 className="tool-group-title">{g.title}</h4>
        {body}
      </section>
    );
  };

  const mcpAll = has("mcp__*");
  return (
    <div className="tool-picker">
      {TOOL_GROUPS.filter((g) => !g.advanced).map(group)}
      <section className="tool-group">
        <h4 className="tool-group-title">Connected tools (MCP)</h4>
        <div className="tool-rows">
          <div className={`tool-row ${mcpAll ? "on" : ""}`}>
            <input id="tool-mcp-all" type="checkbox" checked={mcpAll} onChange={(e) => setTool("mcp__*", e.target.checked)} />
            <label htmlFor="tool-mcp-all" className="tool-text">
              <span className="tool-label">Every server</span>
              <span className="tool-help">All tools from every MCP server, now and later. Tools that change things ask first.</span>
            </label>
          </div>
          {mcpServers.map((s) => {
            const name = `mcp__${s.name}__*`;
            const on = mcpAll || has(name);
            return (
              <div key={s.name} className={`tool-row ${on ? "on" : ""}`}>
                <input id={`tool-${name}`} type="checkbox" checked={on} disabled={mcpAll} onChange={(e) => setTool(name, e.target.checked)} />
                <label htmlFor={`tool-${name}`} className="tool-text">
                  <span className="tool-label">
                    {s.name}
                    {s.status !== "connected" && <span className="pill">{s.status}</span>}
                  </span>
                  <span className="tool-help">{s.tools.length ? `${s.tools.length} tools: ${s.tools.map((t) => t.name).join(", ")}` : "No tools reported yet."}</span>
                </label>
              </div>
            );
          })}
          {!mcpServers.length && (
            <p className="tool-help pad-row">
              No servers set up. Add one in <a href="#/settings/mcp">Settings › MCP servers</a>.
            </p>
          )}
        </div>
      </section>
      {TOOL_GROUPS.filter((g) => g.advanced).map(group)}
    </div>
  );
}
