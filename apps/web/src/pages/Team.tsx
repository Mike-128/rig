import { useEffect, useState } from "react";
import { api } from "../api";

interface Connection {
  host: string;
  login: string;
  name: string | null;
  method: "gh-cli" | "token" | "device";
}

interface Pending {
  id: string;
  kind: "agent" | "skill" | "memory";
  name: string;
  op: "upsert" | "delete";
  files: Record<string, string>;
  summary: string;
  origin: "user" | "agent";
  createdAt: string;
}

interface PullRequest {
  number: number;
  url: string;
  title: string;
  items: { kind: string; name: string; op: string }[];
  state: "open" | "merged" | "closed";
  review: "approved" | "changes_requested" | "review_required";
  updatedAt: string;
}

export interface TeamStatus {
  config?: { owner: string; repo: string; branch: string };
  url?: string;
  initialized: boolean;
  syncedSha?: string;
  syncedAt?: string;
  protected?: boolean;
  canPush?: boolean;
  error?: string;
  pending: Pending[];
  pullRequests: PullRequest[];
}

const METHOD_LABEL = { "gh-cli": "GitHub CLI sign-in", token: "token", device: "browser sign-in" };
const REVIEW_LABEL = { approved: "approved", changes_requested: "changes requested", review_required: "awaiting review" };

const decode = (b64: string) => {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return "(binary)";
  }
};

function SignIn({ onDone }: { onDone: (c: Connection) => void }) {
  const [host, setHost] = useState("github.com");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState(() => localStorage.getItem("rig.github.clientId") ?? "");
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<Connection | void>) {
    setBusy(true);
    setError(null);
    try {
      const c = await fn();
      if (c) onDone(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startDevice() {
    localStorage.setItem("rig.github.clientId", clientId);
    const d = await api<{ userCode: string; verificationUri: string }>("/github/device", { method: "POST", json: { host, clientId } });
    setDevice(d);
    window.open(d.verificationUri, "_blank");
    for (;;) {
      const r = await api<{ status: string; connection?: Connection; retryIn?: number }>("/github/device/poll", { method: "POST" });
      if (r.status === "done" && r.connection) {
        setDevice(null);
        return r.connection;
      }
      if (r.status !== "pending") {
        setDevice(null);
        throw new Error(r.status === "denied" ? "The sign-in was declined on GitHub." : "The sign-in code expired. Try again.");
      }
      await new Promise((res) => setTimeout(res, (r.retryIn ?? 5) * 1000));
    }
  }

  return (
    <div className="card">
      <h3>Sign in to GitHub</h3>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Rig acts as you on GitHub: it reads the team repo and opens pull requests in your name. The sign-in stays in your OS keychain.
      </div>
      <label className="field">
        <span>GitHub host</span>
        <input className="mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" />
        <span className="muted small">github.com, including Enterprise Managed Users; or your data-residency host such as acme.ghe.com.</span>
      </label>
      <div className="signin-options">
        <div>
          <b>Use your GitHub CLI sign-in</b>
          <div className="muted small">
            Recommended for EMU. If needed, run <span className="mono">gh auth login --hostname {host || "github.com"}</span> in a terminal first.
          </div>
          <button className="primary" disabled={busy} onClick={() => run(() => api<{ connection: Connection }>("/github/gh", { method: "POST", json: { host } }).then((r) => r.connection))}>
            Use gh sign-in
          </button>
        </div>
        <div>
          <b>Paste a token</b>
          <div className="muted small">A fine-grained token for the team repo with Contents and Pull requests set to read and write.</div>
          <div className="row">
            <input type="password" className="mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" />
            <button disabled={busy || token.length < 10} onClick={() => run(() => api<{ connection: Connection }>("/github/token", { method: "POST", json: { host, token } }).then((r) => r.connection))}>
              Sign in
            </button>
          </div>
        </div>
        <details>
          <summary>
            <b>Sign in with the browser</b> <span className="muted small">(needs an OAuth app your enterprise approved)</span>
          </summary>
          <div className="row" style={{ marginTop: 6 }}>
            <input className="mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="OAuth app client ID" />
            <button disabled={busy || clientId.length < 4} onClick={() => run(startDevice)}>
              Start
            </button>
          </div>
          {device && (
            <div className="device-code">
              Enter <span className="mono big-code">{device.userCode}</span> at{" "}
              <a href={device.verificationUri} target="_blank" rel="noreferrer">
                {device.verificationUri}
              </a>
              . Waiting for GitHub…
            </div>
          )}
        </details>
      </div>
      {error && <div className="issue error">{error}</div>}
    </div>
  );
}

export function TeamPage() {
  const [conn, setConn] = useState<Connection | null | undefined>(undefined);
  const [team, setTeam] = useState<TeamStatus | null>(null);
  const [repo, setRepo] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    const g = await api<{ connection: Connection | null }>("/github");
    setConn(g.connection);
    setTeam(await api<TeamStatus>("/team"));
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function act<T>(fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await fn();
      done?.(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sync = () =>
    act(
      () => api<{ changed: number; status: TeamStatus }>("/team/sync", { method: "POST" }),
      (r) => {
        setTeam(r.status);
        setMsg(r.changed ? `Synced: ${r.changed} file(s) changed.` : "Up to date.");
      },
    );

  if (conn === undefined) return <div className="empty">Loading…</div>;

  return (
    <div className="content">
      <div className="scroll narrow">
        <h2 style={{ marginTop: 0 }}>Team</h2>
        <div className="muted small" style={{ marginBottom: 14 }}>
          Share agents, skills, and memory with teammates through a GitHub repository. Every change is a pull request, so the repo's reviews and branch protection decide
          what everyone gets. The repo holds definitions only, not deliverables.
        </div>
        {error && <div className="issue error">{error}</div>}
        {msg && <div className="issue ok">{msg}</div>}

        {!conn ? (
          <SignIn onDone={(c) => {
            setConn(c);
            load();
          }} />
        ) : (
          <div className="card row" style={{ justifyContent: "space-between" }}>
            <div>
              Signed in as <b>{conn.login}</b> on {conn.host} <span className="muted small">via {METHOD_LABEL[conn.method]}</span>
            </div>
            <button onClick={() => act(() => api("/github", { method: "DELETE" }), () => setConn(null))}>Sign out</button>
          </div>
        )}

        {conn && !team?.config && (
          <div className="card">
            <h3>Team repository</h3>
            <div className="muted small" style={{ marginBottom: 8 }}>
              The repository your team shares. A new, empty private repo works; Rig sets it up.
            </div>
            <div className="row">
              <input className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo or https://github.com/owner/repo" onKeyDown={(e) => e.key === "Enter" && repo && act(() => api<TeamStatus>("/team", { method: "PUT", json: { repo } }), setTeam)} />
              <button className="primary" disabled={busy || !repo} onClick={() => act(() => api<TeamStatus>("/team", { method: "PUT", json: { repo } }), setTeam)}>
                Connect
              </button>
            </div>
          </div>
        )}

        {conn && team?.config && (
          <>
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <a href={team.url} target="_blank" rel="noreferrer">
                    <b>
                      {team.config.owner}/{team.config.repo}
                    </b>
                  </a>{" "}
                  <span className="muted small">
                    {team.syncedSha ? `at ${team.syncedSha.slice(0, 7)}, synced ${new Date(team.syncedAt!).toLocaleTimeString()}` : "not synced yet"}
                  </span>
                </div>
                <div className="row">
                  <button disabled={busy} onClick={sync}>
                    Sync now
                  </button>
                  <button className="ghost tiny" title="Disconnect this repository (nothing on GitHub changes)" onClick={() => act(() => api("/team", { method: "DELETE" }), () => load())}>
                    Disconnect
                  </button>
                </div>
              </div>
              {team.error && <div className="issue error">{team.error}</div>}
              {!team.initialized && team.syncedSha === undefined && (
                <div className="issue warning">
                  This repository is empty.{" "}
                  <button className="primary" disabled={busy} onClick={() => act(() => api<TeamStatus>("/team/init", { method: "POST" }), setTeam)}>
                    Set it up for Rig
                  </button>
                </div>
              )}
              {team.protected === false && (
                <div className="issue warning">
                  The {team.config.branch} branch is not protected, so anyone with write access could change shared agents without review. In the repository's Settings →
                  Branches, require a pull request review before merging.
                </div>
              )}
              {team.canPush === false && <div className="issue warning">Your account cannot push branches to this repository, so you cannot propose changes. Ask for write access.</div>}
              <div className="muted small" style={{ marginTop: 6 }}>
                Rig syncs at startup and every five minutes. Merged changes appear for everyone after their next sync.
              </div>
            </div>

            <div className="card">
              <h3>Waiting to be proposed ({team.pending.length})</h3>
              {!team.pending.length && (
                <div className="muted small">
                  Nothing yet. Share an agent or skill from its page, propose a memory on the Memory page, or let an agent propose team memory as it works.
                </div>
              )}
              {team.pending.map((p) => (
                <details key={p.id} className="pending-item">
                  <summary>
                    <span className="badge">{p.kind}</span> <b>{p.name}</b> {p.op === "delete" && <span className="badge danger-badge">remove</span>}
                    {p.origin === "agent" && <span className="badge">from an agent</span>} <span className="muted small">{p.summary}</span>
                    <button className="ghost tiny" style={{ float: "right" }} onClick={(e) => (e.preventDefault(), act(() => api(`/team/pending/${p.id}`, { method: "DELETE" }), () => load()))}>
                      Remove
                    </button>
                  </summary>
                  {Object.entries(p.files).map(([f, b64]) => (
                    <div key={f}>
                      <div className="mono small muted">{f}</div>
                      <pre className="output">{f.endsWith(".md") || f.endsWith(".yaml") || f.endsWith(".json") || f.endsWith(".txt") ? decode(b64).slice(0, 4000) : "(file)"}</pre>
                    </div>
                  ))}
                </details>
              ))}
              {team.pending.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <label className="field">
                    <span>Pull request title (optional)</span>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short summary for reviewers" />
                  </label>
                  <label className="field">
                    <span>Note for reviewers (optional)</span>
                    <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      act(
                        () => api<{ pullRequest: PullRequest; status: TeamStatus }>("/team/pull-request", { method: "POST", json: { title, body: note } }),
                        (r) => {
                          setTeam(r.status);
                          setTitle("");
                          setNote("");
                          setMsg(`Opened pull request #${r.pullRequest.number}. A teammate reviews and merges it on GitHub.`);
                        },
                      )
                    }
                  >
                    {busy ? "Opening…" : `Open pull request (${team.pending.length} change${team.pending.length === 1 ? "" : "s"})`}
                  </button>
                </div>
              )}
            </div>

            <div className="card">
              <h3>Your pull requests</h3>
              {!team.pullRequests.length && <div className="muted small">None yet.</div>}
              {team.pullRequests.map((pr) => (
                <div key={pr.number} className="pr-row">
                  <a href={pr.url} target="_blank" rel="noreferrer">
                    #{pr.number} {pr.title}
                  </a>
                  <span className={`badge pr-${pr.state}`}>{pr.state}</span>
                  {pr.state === "open" && <span className={`badge pr-${pr.review}`}>{REVIEW_LABEL[pr.review]}</span>}
                  <span className="muted small">{pr.items.map((i) => `${i.kind} ${i.name}`).join(", ")}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
