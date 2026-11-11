import { useEffect, useState } from "react";
import { api } from "../api";
import { Markdown } from "../markdown";

type MemoryType = "fact" | "decision" | "convention" | "gotcha" | "preference" | "reference";
const TYPES: MemoryType[] = ["fact", "decision", "convention", "gotcha", "preference", "reference"];

interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  scope: "personal" | "team";
  author?: string;
  updated?: string;
  body: string;
}

interface Draft {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

const BLANK: Draft = { name: "", description: "", type: "fact", body: "" };

export function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [proposed, setProposed] = useState<{ name: string; op: string }[]>([]);
  const [teamConnected, setTeamConnected] = useState(false);
  const [selected, setSelected] = useState<{ name: string; scope: string } | null>(null);
  const [draft, setDraft] = useState<(Draft & { scope: "personal" | "team" }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    api<{ memories: Memory[]; proposed: { name: string; op: string }[]; teamConnected: boolean }>("/memory").then((r) => {
      setMemories(r.memories);
      setProposed(r.proposed);
      setTeamConnected(r.teamConnected);
    });
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  const current = selected && memories.find((m) => m.name === selected.name && m.scope === selected.scope);

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      await api(`/memory/${draft.scope}/${encodeURIComponent(draft.name)}`, { method: "PUT", json: { description: draft.description, type: draft.type, body: draft.body } });
      setMsg(draft.scope === "team" ? `Proposed "${draft.name}" to the team. Open a pull request in Settings, Team and GitHub.` : `Saved "${draft.name}".`);
      setDraft(null);
      await load();
      if (draft.scope === "personal") setSelected({ name: draft.name, scope: "personal" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(m: Memory) {
    setError(null);
    try {
      if (m.scope === "personal") await api(`/memory/personal/${m.name}`, { method: "DELETE" });
      else await api("/team/remove", { method: "POST", json: { kind: "memory", name: m.name } });
      setMsg(m.scope === "team" ? `Proposed removing "${m.name}". Open a pull request in Settings, Team and GitHub.` : `Deleted "${m.name}".`);
      setSelected(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const group = (scope: "personal" | "team") => memories.filter((m) => m.scope === scope);

  return (
    <div className="split">
      <aside className="side">
        <button className="primary" style={{ width: "100%", marginBottom: 10 }} onClick={() => (setSelected(null), setDraft({ ...BLANK, scope: "personal" }))}>
          New memory
        </button>
        {(["personal", "team"] as const).map((scope) => (
          <div key={scope}>
            <h3>{scope === "personal" ? "Yours" : "Team"}</h3>
            {group(scope).map((m) => (
              <a key={m.name} className={`list-item ${selected?.name === m.name && selected.scope === scope ? "active" : ""}`} onClick={() => (setDraft(null), setSelected({ name: m.name, scope }))}>
                <div>
                  {m.name} <span className="badge">{m.type}</span>
                  {proposed.some((p) => p.name === m.name) && scope === "team" && <span className="badge">change proposed</span>}
                </div>
                <div className="sub clamp">{m.description}</div>
              </a>
            ))}
            {!group(scope).length && <div className="muted small pad">{scope === "team" && !teamConnected ? "Connect a team repo in Settings, Team and GitHub." : "None yet."}</div>}
          </div>
        ))}
        {proposed.filter((p) => !memories.some((m) => m.scope === "team" && m.name === p.name)).length > 0 && (
          <div className="muted small pad">
            Proposed, not yet merged: {proposed.filter((p) => !memories.some((m) => m.scope === "team" && m.name === p.name)).map((p) => p.name).join(", ")}
          </div>
        )}
      </aside>
      <section className="content">
        <div className="scroll narrow">
          {error && <div className="issue error">{error}</div>}
          {msg && <div className="issue ok">{msg}</div>}
          {draft ? (
            <div className="card">
              <h3>{draft.scope === "team" ? "Propose a team memory" : "Personal memory"}</h3>
              <div className="grid2">
                <label className="field">
                  <span>Name (lowercase, dashes)</span>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="deploys-need-vpn" />
                </label>
                <label className="field">
                  <span>Type</span>
                  <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}>
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Description: one line, shown to agents in their memory index</span>
                <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
              <label className="field">
                <span>Memory (markdown, short; for decisions and gotchas say why)</span>
                <textarea rows={8} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </label>
              {teamConnected && (
                <label className="checks">
                  <span>
                    <input type="checkbox" checked={draft.scope === "team"} onChange={(e) => setDraft({ ...draft, scope: e.target.checked ? "team" : "personal" })} /> Propose to the team
                    (reviewed in a pull request before teammates see it)
                  </span>
                </label>
              )}
              <div className="row">
                <button className="primary" disabled={!draft.name || !draft.description || !draft.body} onClick={save}>
                  {draft.scope === "team" ? "Propose" : "Save"}
                </button>
                <button onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          ) : current ? (
            <>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>
                  {current.name} <span className="badge">{current.scope === "team" ? "team" : "yours"}</span> <span className="badge">{current.type}</span>
                </h2>
                <div className="row">
                  {current.scope === "personal" && teamConnected && <button onClick={() => setDraft({ ...current, scope: "team" })}>Propose to team</button>}
                  <button onClick={() => setDraft({ ...current })}>{current.scope === "team" ? "Propose edit" : "Edit"}</button>
                  <button className="danger" onClick={() => remove(current)}>
                    {current.scope === "team" ? "Propose removal" : "Delete"}
                  </button>
                </div>
              </div>
              <div className="card">
                <div className="muted">{current.description}</div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  {current.author && `by ${current.author}, `}
                  {current.updated && `updated ${current.updated}`}
                </div>
              </div>
              <div className="card">
                <Markdown text={current.body} />
              </div>
            </>
          ) : (
            <div className="empty">
              Memories are short notes agents read at the start of every session: decisions, conventions, gotchas, preferences. Agents with memory_write save them as they
              work. Yours apply only to you; team memories reach everyone after a reviewed pull request.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
