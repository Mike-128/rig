import { useEffect, useState } from "react";
import type { Skill, SkillSummary } from "@rig/core/types";
import { api } from "../api";

interface SkillsResponse {
  skills: SkillSummary[];
  problems: { dir: string; error: string }[];
}

const BLANK = { name: "", description: "", body: "" };

const SOURCE_LABEL: Record<SkillSummary["source"], string> = {
  bundled: "bundled",
  user: "yours",
  team: "team",
  claude: "Claude Code",
  project: "project",
};

interface Preview {
  repo: string;
  ref: string;
  sha: string;
  path: string;
  skills: { name: string; description: string; path: string; files: string[]; error?: string; installed: boolean }[];
}

/** Paste a GitHub link, see what is there, install some or all of it. */
function GitHubInstall({ onInstalled }: { onInstalled: (names: string[]) => void }) {
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function look() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const p = await api<Preview>("/skills/github/preview", { method: "POST", json: { source } });
      setPreview(p);
      // One skill is what the user linked to; from a collection, let them choose.
      const ok = p.skills.filter((s) => !s.error);
      setPicked(new Set(ok.length === 1 ? [ok[0].name] : []));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ installed: string[]; errors: { name: string; error: string }[] }>("/skills/github/install", {
        method: "POST",
        json: { source, names: [...picked] },
      });
      if (res.errors.length) setError(res.errors.map((e) => `${e.name}: ${e.error}`).join("; "));
      onInstalled(res.installed);
      setPreview(null);
      setSource("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Install from GitHub</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>
        A repository, a folder in one, or a SKILL.md link. Every folder with a SKILL.md is a skill, for example{" "}
        <span className="mono">https://github.com/anthropics/skills</span>. Installs go to ~/.rig/skills and can be updated later.
      </div>
      <div className="row">
        <input
          className="mono"
          value={source}
          placeholder="https://github.com/owner/repo/tree/main/skills"
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && source && look()}
        />
        <button disabled={!source || busy} onClick={look}>
          {busy && !preview ? "Looking…" : "Look"}
        </button>
      </div>
      {error && <div className="issue error">{error}</div>}
      {preview && (
        <>
          <div className="muted small" style={{ margin: "10px 0 6px" }}>
            {preview.repo} @ {preview.ref} ({preview.sha.slice(0, 7)}){preview.path ? ` / ${preview.path}` : ""}: {preview.skills.length} skill(s){" "}
            {preview.skills.length > 1 && (
              <button className="ghost tiny" onClick={() => setPicked(picked.size ? new Set() : new Set(preview.skills.filter((s) => !s.error).map((s) => s.name)))}>
                {picked.size ? "Select none" : "Select all"}
              </button>
            )}
          </div>
          <div className="checks">
            {preview.skills.map((s) => (
              <label key={s.path || s.name} title={s.error ?? s.description}>
                <input
                  type="checkbox"
                  disabled={Boolean(s.error)}
                  checked={picked.has(s.name)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(s.name);
                    else next.delete(s.name);
                    setPicked(next);
                  }}
                />
                <span>
                  <b>{s.name}</b> {s.installed && <span className="badge">installed</span>}{" "}
                  <span className="muted clamp">{s.error ? `cannot install: ${s.error}` : s.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="row">
            <button className="primary" disabled={!picked.size || busy} onClick={install}>
              {busy ? "Installing…" : `Install ${picked.size}`}
            </button>
            <button onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

export function SkillsPage({ initialName }: { initialName?: string }) {
  const [data, setData] = useState<SkillsResponse>({ skills: [], problems: [] });
  const [selected, setSelected] = useState<string | undefined>(initialName);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [draft, setDraft] = useState(BLANK);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [teamConnected, setTeamConnected] = useState(false);
  useEffect(() => {
    api<{ config?: unknown }>("/team")
      .then((t) => setTeamConnected(Boolean(t.config)))
      .catch(() => {});
  }, []);

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
          style={{ width: "100%", marginBottom: 6 }}
          onClick={() => {
            setSelected(undefined);
            setDetail(null);
            setEditing(false);
            setInstalling(true);
          }}
        >
          Install from GitHub
        </button>
        <button
          className="primary"
          style={{ width: "100%", marginBottom: 10 }}
          onClick={() => {
            setSelected(undefined);
            setDetail(null);
            setDraft(BLANK);
            setEditing(true);
            setInstalling(false);
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
              setInstalling(false);
            }}
          >
            <div>
              {s.name} <span className="badge">{SOURCE_LABEL[s.source]}</span>
              {s.origin && <span className="badge">github</span>}
            </div>
            <div className="sub clamp">{s.description}</div>
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

          {installing && !selected ? (
            <GitHubInstall
              onInstalled={async (names) => {
                await refresh();
                if (names.length) {
                  setMsg(`Installed ${names.join(", ")}`);
                  setInstalling(false);
                  setSelected(names[0]);
                }
              }}
            />
          ) : creating ? (
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
                  {detail.name} <span className="badge">{SOURCE_LABEL[detail.source]}</span> <span className="badge">{detail.hash}</span>
                </h2>
                <div className="row">
                  {teamConnected && ["user", "claude", "project"].includes(detail.source) && (
                    <button
                      onClick={async () => {
                        setError(null);
                        try {
                          await api("/team/share", { method: "POST", json: { kind: "skill", name: detail.name } });
                          setMsg("Queued for the team. Open the pull request on the Team page.");
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Share with team
                    </button>
                  )}
                  {detail.source === "team" && (
                    <button
                      className="danger"
                      onClick={async () => {
                        await api("/team/remove", { method: "POST", json: { kind: "skill", name: detail.name } });
                        setMsg("Proposed removing this skill from the team. Open the pull request on the Team page.");
                      }}
                    >
                      Propose removal
                    </button>
                  )}
                  {detail.origin && (
                    <button
                      onClick={async () => {
                        setError(null);
                        try {
                          const r = await api<{ sha: string; previousSha?: string }>(`/skills/${encodeURIComponent(detail.name)}/update`, { method: "POST" });
                          setMsg(r.sha === r.previousSha ? "Already up to date" : `Updated to ${r.sha.slice(0, 7)}`);
                          await refresh();
                          setDetail(await api<Skill>(`/skills/${detail.name}`));
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Update from GitHub
                    </button>
                  )}
                  <button onClick={() => setEditing((e) => !e)}>{editing ? "Cancel" : detail.source === "user" ? "Edit" : "Copy and edit"}</button>
                  {detail.source === "user" && (
                    <button className="danger" onClick={() => remove(detail.name)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
              <div className="card">
                <div className="muted">{detail.description}</div>
                <div className="muted small mono" style={{ marginTop: 6 }}>
                  {detail.dir}
                  {detail.origin && ` · from github.com/${detail.origin.repo}/${detail.origin.path} @ ${detail.origin.sha?.slice(0, 7) ?? detail.origin.ref}`}
                </div>
                <div className="muted small" style={{ marginTop: 6 }}>
                  Run it in a session with <span className="mono">/{detail.name}</span>, or attach it to an agent.
                </div>
              </div>
              {editing ? (
                <div className="card">
                  {detail.source !== "user" && (
                    <div className="issue warning">Saving creates your own copy in ~/.rig/skills, which shadows this one.</div>
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
