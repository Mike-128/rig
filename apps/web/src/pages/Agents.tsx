import { useEffect, useState } from "react";
import type { AgentSummary, Model, ModelAlias, SkillSummary } from "@harness/core/types";
import { MANAGEMENT_TOOLS, slugify, type AgentDefinitionInput, type ValidationIssue } from "@harness/core/agent";
import { api } from "../api";

type ModelRow = Model & { connectionName: string };

const WORKSPACE_TOOLS = ["file_read", "file_write", "web_fetch", "shell", "load_skill"] as const;

const TOOL_HELP: Record<string, string> = {
  file_read: "Read files and list directories inside the workspace. Read-only.",
  file_write: "Create or overwrite files inside the workspace. Needs sandbox 1.",
  web_fetch: "Fetch a public http(s) URL as text. Read-only.",
  shell: "Run a command in the workspace directory. Needs sandbox 1; the widest capability here.",
  load_skill: "Read the full instructions for an attached skill. Added automatically when you attach one.",
  agent_list: "List the agents saved in this harness.",
  agent_read: "Read another agent's definition.",
  agent_write: "Create or update agents. Gate this with approval.",
  model_list: "See which models this harness can reach.",
  skill_list: "List installed skills.",
  skill_write: "Create or replace skills. Gate this with approval.",
};

interface Form {
  name: string;
  slug: string;
  description: string;
  instructions: string;
  bindingKind: "alias" | "explicit";
  alias: string;
  connection: string;
  model: string;
  tools: string[];
  skills: string[];
  approvals: string[];
  sandbox: 0 | 1;
  maxTurns: number;
  tokens: string;
  usd: string;
  temperature: string;
  maxOutputTokens: string;
  reasoningEffort: "" | "low" | "medium" | "high";
}

const blank = (): Form => ({
  name: "",
  slug: "",
  description: "",
  instructions: "You are a helpful assistant.",
  bindingKind: "alias",
  alias: "default",
  connection: "",
  model: "",
  tools: ["web_fetch", "file_read"],
  skills: [],
  approvals: [],
  sandbox: 1,
  maxTurns: 25,
  tokens: "",
  usd: "",
  temperature: "",
  maxOutputTokens: "",
  reasoningEffort: "",
});

function toInput(f: Form): AgentDefinitionInput {
  return {
    name: f.name,
    slug: f.slug,
    description: f.description || undefined,
    model: f.bindingKind === "alias" ? { alias: f.alias } : { connection: f.connection, model: f.model },
    instructions: f.instructions,
    tools: f.tools as AgentDefinitionInput["tools"],
    skills: f.skills,
    sandbox: f.sandbox,
    approvals: f.approvals as AgentDefinitionInput["approvals"],
    budget: {
      maxTurns: f.maxTurns,
      tokens: f.tokens ? Number(f.tokens) : undefined,
      usd: f.usd ? Number(f.usd) : undefined,
    },
    params: {
      temperature: f.temperature ? Number(f.temperature) : undefined,
      maxOutputTokens: f.maxOutputTokens ? Number(f.maxOutputTokens) : undefined,
      reasoningEffort: f.reasoningEffort || undefined,
    },
  };
}

function fromDefinition(d: Record<string, unknown>): Form {
  const f = blank();
  const model = d.model as { alias?: string; connection?: string; model?: string };
  const budget = (d.budget ?? {}) as { maxTurns?: number; tokens?: number; usd?: number };
  const params = (d.params ?? {}) as { temperature?: number; maxOutputTokens?: number; reasoningEffort?: string };
  return {
    ...f,
    name: String(d.name ?? ""),
    slug: String(d.slug ?? ""),
    description: String(d.description ?? ""),
    instructions: String(d.instructions ?? ""),
    bindingKind: model.alias ? "alias" : "explicit",
    alias: model.alias ?? "default",
    connection: model.connection ?? "",
    model: model.model ?? "",
    tools: (d.tools as string[]) ?? [],
    skills: (d.skills as string[]) ?? [],
    approvals: (d.approvals as string[]) ?? [],
    sandbox: (d.sandbox as 0 | 1) ?? 1,
    maxTurns: budget.maxTurns ?? 25,
    tokens: budget.tokens ? String(budget.tokens) : "",
    usd: budget.usd ? String(budget.usd) : "",
    temperature: params.temperature !== undefined ? String(params.temperature) : "",
    maxOutputTokens: params.maxOutputTokens ? String(params.maxOutputTokens) : "",
    reasoningEffort: (params.reasoningEffort as Form["reasoningEffort"]) ?? "",
  };
}

export function AgentsPage({ initialSlug }: { initialSlug?: string }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [form, setForm] = useState<Form>(blank());
  const [editing, setEditing] = useState<string | undefined>(initialSlug);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [yaml, setYaml] = useState("");
  const [importText, setImportText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);

  const refresh = () => api<AgentSummary[]>("/agents").then(setAgents);

  useEffect(() => {
    setEditing(initialSlug);
  }, [initialSlug]);

  useEffect(() => {
    refresh();
    api<ModelRow[]>("/models").then(setModels).catch(() => {});
    api<ModelAlias[]>("/aliases").then(setAliases).catch(() => {});
    api<{ skills: SkillSummary[] }>("/skills").then((d) => setSkills(d.skills)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!editing) {
      setForm(blank());
      setYaml("");
      setVersion(null);
      return;
    }
    api<Record<string, unknown>>(`/agents/${editing}`)
      .then((d) => {
        setForm(fromDefinition(d));
        setVersion(Number(d.version ?? 1));
      })
      .catch(() => {});
    fetch(`/api/agents/${editing}/export`)
      .then((r) => r.text())
      .then(setYaml)
      .catch(() => {});
  }, [editing]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function validate() {
    const res = await api<{ ok: boolean; issues: ValidationIssue[] }>("/agents/validate", { method: "POST", json: toInput(form) });
    setIssues(res.issues);
    return res.ok;
  }

  async function save() {
    setMsg(null);
    const slug = form.slug || slugify(form.name);
    const body = { ...toInput(form), slug };
    try {
      const res = await api<{ ok: boolean; issues: ValidationIssue[]; saved?: { version: number } }>(`/agents/${slug}`, { method: "PUT", json: body });
      setIssues(res.issues);
      if (res.ok) {
        setMsg(`Saved ${slug} v${res.saved?.version}`);
        setEditing(slug);
        location.hash = `#/agents/${slug}`;
        refresh();
      }
    } catch (e) {
      const err = e as { body?: { issues?: ValidationIssue[] }; message: string };
      setIssues(err.body?.issues ?? [{ path: "", message: err.message, severity: "error" }]);
    }
  }

  async function remove() {
    if (!editing) return;
    await api(`/agents/${editing}`, { method: "DELETE" });
    setEditing(undefined);
    location.hash = "#/agents";
    refresh();
  }

  async function doImport() {
    setMsg(null);
    try {
      const res = await api<{ ok: boolean; issues: ValidationIssue[]; saved?: { slug: string; version: number } }>("/agents/import", {
        method: "POST",
        body: importText,
        headers: { "content-type": "application/yaml" },
      });
      setIssues(res.issues);
      if (res.ok && res.saved) {
        setMsg(`Imported ${res.saved.slug} v${res.saved.version}`);
        setImportText("");
        setEditing(res.saved.slug);
        refresh();
      }
    } catch (e) {
      const err = e as { body?: { issues?: ValidationIssue[] }; message: string };
      setIssues(err.body?.issues ?? [{ path: "", message: err.message, severity: "error" }]);
    }
  }

  async function runIt() {
    if (!editing) return;
    const s = await api<{ id: string }>("/sessions", { method: "POST", json: { agent: editing } });
    location.hash = `#/chat/${s.id}`;
  }

  const toggle = (list: "tools" | "approvals" | "skills", name: string) =>
    set(list, form[list].includes(name) ? form[list].filter((t) => t !== name) : [...form[list], name]);

  // Attaching a skill implies the agent needs load_skill to read it.
  const toggleSkill = (name: string) => {
    const has = form.skills.includes(name);
    const next = has ? form.skills.filter((s) => s !== name) : [...form.skills, name];
    setForm((f) => ({ ...f, skills: next, tools: next.length && !f.tools.includes("load_skill") ? [...f.tools, "load_skill"] : f.tools }));
  };

  const connections = [...new Map(models.map((m) => [m.connectionId, m.connectionName])).entries()];
  const modelsForConn = models.filter((m) => m.connectionId === form.connection || m.connectionName === form.connection);

  return (
    <div className="split">
      <aside className="side">
        <button
          className="primary"
          style={{ width: "100%", marginBottom: 10 }}
          onClick={() => {
            setEditing(undefined);
            location.hash = "#/agents";
          }}
        >
          New agent
        </button>
        <button
          style={{ width: "100%", marginBottom: 12 }}
          onClick={async () => {
            const s = await api<{ id: string }>("/sessions", { method: "POST", json: { agent: "agent-builder" } });
            location.hash = `#/chat/${s.id}`;
          }}
        >
          Or describe one in chat
        </button>
        <h3>Library</h3>
        {agents.map((a) => (
          <a key={a.slug} className={`list-item ${a.slug === editing ? "active" : ""}`} href={`#/agents/${a.slug}`} onClick={() => setEditing(a.slug)}>
            <div>{a.name}</div>
            <div className="sub">
              {a.slug} · v{a.version}
            </div>
          </a>
        ))}
        <h3 style={{ marginTop: 18 }}>Import YAML</h3>
        <textarea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="paste an agent definition" />
        <button style={{ marginTop: 6, width: "100%" }} onClick={doImport} disabled={!importText.trim()}>
          Import
        </button>
      </aside>
      <section className="content">
        <div className="scroll">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>
              {editing ? `${form.name || editing}` : "New agent"} {version !== null && <span className="badge">v{version}</span>}
            </h2>
            <div className="row">
              {editing && (
                <>
                  <button onClick={runIt}>Run in chat</button>
                  <a className="btn" href={`/api/agents/${editing}/export`} download={`${editing}.yaml`}>
                    Export
                  </a>
                  <button className="danger" onClick={remove}>
                    Delete
                  </button>
                </>
              )}
              <button onClick={validate}>Validate</button>
              <button className="primary" onClick={save} disabled={!form.name.trim() || !form.instructions.trim()}>
                Save
              </button>
            </div>
          </div>
          {msg && <div className="issue" style={{ color: "var(--ok)" }}>{msg}</div>}
          {issues.map((i, n) => (
            <div key={n} className={`issue ${i.severity}`}>
              {i.severity}: {i.path ? `${i.path}: ` : ""}
              {i.message}
            </div>
          ))}

          <div className="card">
            <div className="grid2">
              <label className="field">
                <span>Name</span>
                <input
                  value={form.name}
                  onChange={(e) => {
                    set("name", e.target.value);
                    if (!editing) set("slug", slugify(e.target.value));
                  }}
                />
              </label>
              <label className="field">
                <span>Slug</span>
                <input value={form.slug} onChange={(e) => set("slug", e.target.value)} disabled={!!editing} />
              </label>
            </div>
            <label className="field">
              <span>Description</span>
              <input value={form.description} onChange={(e) => set("description", e.target.value)} />
            </label>
            <label className="field">
              <span>Instructions (system prompt)</span>
              <textarea rows={8} value={form.instructions} onChange={(e) => set("instructions", e.target.value)} />
            </label>
          </div>

          <div className="card">
            <h3>Model</h3>
            <div className="checks" style={{ marginBottom: 10 }}>
              <label>
                <input type="radio" checked={form.bindingKind === "alias"} onChange={() => set("bindingKind", "alias")} /> alias (resolved per machine)
              </label>
              <label>
                <input type="radio" checked={form.bindingKind === "explicit"} onChange={() => set("bindingKind", "explicit")} /> explicit model
              </label>
            </div>
            {form.bindingKind === "alias" ? (
              <label className="field">
                <span>Alias</span>
                <input list="aliases" value={form.alias} onChange={(e) => set("alias", e.target.value)} />
                <datalist id="aliases">
                  {aliases.map((a) => (
                    <option key={a.alias} value={a.alias} />
                  ))}
                </datalist>
                <span className="muted">
                  {aliases.find((a) => a.alias === form.alias)
                    ? `bound to ${aliases.find((a) => a.alias === form.alias)!.modelId}`
                    : "not bound yet: set it in the Model Catalog"}
                </span>
              </label>
            ) : (
              <div className="grid2">
                <label className="field">
                  <span>Connection</span>
                  <select value={form.connection} onChange={(e) => set("connection", e.target.value)}>
                    <option value="">choose…</option>
                    {connections.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Model</span>
                  <select value={form.model} onChange={(e) => set("model", e.target.value)}>
                    <option value="">choose…</option>
                    {modelsForConn.map((m) => (
                      <option key={m.id} value={m.providerModelId}>
                        {m.displayName} ({m.status})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <div className="grid2">
              <label className="field">
                <span>Temperature (blank = provider default)</span>
                <input value={form.temperature} onChange={(e) => set("temperature", e.target.value)} placeholder="e.g. 0.2" />
              </label>
              <label className="field">
                <span>Max output tokens</span>
                <input value={form.maxOutputTokens} onChange={(e) => set("maxOutputTokens", e.target.value)} placeholder="e.g. 8000" />
              </label>
            </div>
            <label className="field">
              <span>Reasoning effort (only sent to models that support it)</span>
              <select value={form.reasoningEffort} onChange={(e) => set("reasoningEffort", e.target.value as Form["reasoningEffort"])}>
                <option value="">provider default</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
          </div>

          <div className="card">
            <h3>Skills</h3>
            <div className="muted" style={{ marginBottom: 8 }}>
              Only the descriptions sit in the agent's context. It loads the full instructions on demand with load_skill, which is added automatically when you attach one.
            </div>
            <div className="checks">
              {skills.map((s) => (
                <label key={s.name} title={s.description}>
                  <input type="checkbox" checked={form.skills.includes(s.name)} onChange={() => toggleSkill(s.name)} /> {s.name}
                </label>
              ))}
              {!skills.length && (
                <span className="muted">
                  No skills installed. <a href="#/skills">Create one</a>.
                </span>
              )}
            </div>
          </div>

          <div className="card">
            <h3>Tools and policy</h3>
            <div className="field">
              <span className="muted">Workspace tools</span>
              <div className="checks">
                {WORKSPACE_TOOLS.map((t) => (
                  <label key={t} title={TOOL_HELP[t]}>
                    <input type="checkbox" checked={form.tools.includes(t)} onChange={() => toggle("tools", t)} /> {t}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="muted">Harness management tools — let this agent create and revise other agents and skills</span>
              <div className="checks">
                {MANAGEMENT_TOOLS.map((t) => (
                  <label key={t} title={TOOL_HELP[t]}>
                    <input type="checkbox" checked={form.tools.includes(t)} onChange={() => toggle("tools", t)} /> {t}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="muted">Require approval before running</span>
              <div className="checks">
                {form.tools.map((t) => (
                  <label key={t}>
                    <input type="checkbox" checked={form.approvals.includes(t)} onChange={() => toggle("approvals", t)} /> {t}
                  </label>
                ))}
                {!form.tools.length && <span className="muted">no tools enabled</span>}
              </div>
            </div>
            <div className="grid2">
              <label className="field">
                <span>Sandbox level</span>
                <select value={form.sandbox} onChange={(e) => set("sandbox", Number(e.target.value) as 0 | 1)}>
                  <option value={0}>0: read-only, no process spawn</option>
                  <option value={1}>1: workspace-jailed local subprocess</option>
                </select>
              </label>
              <label className="field">
                <span>Max turns per run</span>
                <input type="number" min={1} max={200} value={form.maxTurns} onChange={(e) => set("maxTurns", Number(e.target.value))} />
              </label>
              <label className="field">
                <span>Token budget per run (optional)</span>
                <input value={form.tokens} onChange={(e) => set("tokens", e.target.value)} placeholder="e.g. 500000" />
              </label>
              <label className="field">
                <span>Cost budget per run in USD (optional)</span>
                <input value={form.usd} onChange={(e) => set("usd", e.target.value)} placeholder="e.g. 2" />
              </label>
            </div>
          </div>

          {yaml && (
            <div className="card">
              <h3>Saved definition (YAML)</h3>
              <pre className="yaml">{yaml}</pre>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
