import { useEffect, useState } from "react";
import type { Skill, SkillSummary } from "@harness/core/types";
import { api } from "../api";

interface SkillsResponse {
  skills: SkillSummary[];
  problems: { dir: string; error: string }[];
}

const BLANK = { name: "", description: "", body: "" };

export function SkillsPage({ initialName }: { initialName?: string }) {
  const [data, setData] = useState<SkillsResponse>({ skills: [], problems: [] });
  const [selected, setSelected] = useState<string | undefined>(initialName);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [draft, setDraft] = useState(BLANK);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => api<SkillsResponse>("/skills").then(setData);

  useEffect(() => {
    setSelected(initialName);
  }, [initialName]);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api<Skill>(`/skills/${selected}`)
      .then((s) => {
        setDetail(s);
        setEditing(false);
      })
      .catch((e) => setError(e.message));
  }, [selected]);

  async function save(name: string, description: string, body: string) {
    setError(null);
    setMsg(null);
    try {
      await api(`/skills/${encodeURIComponent(name)}`, { method: "PUT", json: { description, body } });
      setMsg(`Saved ${name}`);
      await refresh();
      setSelected(name);
      setEditing(false);
      setDraft(BLANK);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(name: string) {
    try {
      await api(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      setSelected(undefined);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const creating = editing && !selected;

  return (
    <div className="split">
      <aside className="side">
        <button
          className="primary"
          style={{ width: "100%", marginBottom: 10 }}
          onClick={() => {
            setSelected(undefined);
            setDetail(null);
            setDraft(BLANK);
            setEditing(true);
          }}
        >
          New skill
        </button>
        <h3>Skills</h3>
        {data.skills.map((s) => (
          <a
            key={s.name}
            className={`list-item ${s.name === selected ? "active" : ""}`}
            href={`#/skills/${s.name}`}
            onClick={() => {
              setSelected(s.name);
              setEditing(false);
            }}
          >
            <div>
              {s.name} <span className="badge">{s.source}</span>
            </div>
            <div className="sub">{s.description}</div>
          </a>
        ))}
        {!data.skills.length && <div className="muted">No skills installed.</div>}
      </aside>
      <section className="content">
        <div className="scroll">
          {error && <div className="issue error">{error}</div>}
          {msg && <div className="issue" style={{ color: "var(--ok)" }}>{msg}</div>}
          {data.problems.map((p, i) => (
            <div key={i} className="issue warning">
              {p.dir}: {p.error}
            </div>
          ))}

          {creating ? (
            <div className="card">
              <h3>New skill</h3>
              <div className="grid2">
                <label className="field">
                  <span>Name (lowercase, dashes)</span>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="release-notes" />
                </label>
              </div>
              <label className="field">
                <span>Description — the only part always in context; it decides when the skill gets loaded</span>
                <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
              <label className="field">
                <span>Body — markdown instructions for performing the task</span>
                <textarea rows={16} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </label>
              <div className="row">
                <button className="primary" disabled={!draft.name || !draft.description || !draft.body} onClick={() => save(draft.name, draft.description, draft.body)}>
                  Create
                </button>
                <button onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : !detail ? (
            <div className="empty">Pick a skill, or create one. Skills are reusable instructions any agent can be given; only their descriptions sit in context until the agent loads them.</div>
          ) : (
            <>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>
                  {detail.name} <span className="badge">{detail.source}</span> <span className="badge">{detail.hash}</span>
                </h2>
                <div className="row">
                  <button onClick={() => setEditing((e) => !e)}>{editing ? "Cancel" : detail.source === "bundled" ? "Copy and edit" : "Edit"}</button>
                  {detail.source === "user" && (
                    <button className="danger" onClick={() => remove(detail.name)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
              <div className="card">
                <div className="muted">{detail.description}</div>
              </div>
              {editing ? (
                <div className="card">
                  {detail.source === "bundled" && (
                    <div className="issue warning">Saving creates a user copy that shadows the bundled skill of the same name.</div>
                  )}
                  <label className="field">
                    <span>Description</span>
                    <input defaultValue={detail.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>Body</span>
                    <textarea rows={20} defaultValue={detail.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                  </label>
                  <button
                    className="primary"
                    onClick={() => save(detail.name, draft.description || detail.description, draft.body || detail.body)}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <div className="card">
                  <pre className="yaml" style={{ maxHeight: "none" }}>
                    {detail.body}
                  </pre>
                  {detail.files.length > 0 && (
                    <>
                      <h3 style={{ marginTop: 14 }}>Bundled files</h3>
                      <ul className="mono">
                        {detail.files.map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
