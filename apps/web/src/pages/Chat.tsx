import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSummary, RunEvent, Session } from "@rig/core/types";
import { api, streamSession } from "../api";
import { emptyThread, reduceAll, reduceEvent, type ThreadItem, type ThreadState } from "../events";

interface SessionDetail {
  session: Session;
  runs: { id: string; status: string }[];
  events: RunEvent[];
}

export function ChatPage({ initialSession }: { initialSession?: string }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>(initialSession);
  const [session, setSession] = useState<Session | null>(null);
  const [thread, setThread] = useState<ThreadState>(emptyThread());
  const [input, setInput] = useState("");
  const [agentForNew, setAgentForNew] = useState("assistant");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<() => void>(() => {});

  const refreshSessions = useCallback(() => api<Session[]>("/sessions").then(setSessions).catch(() => {}), []);

  // The URL is the source of truth for which session is open, so back/forward and shared links work.
  useEffect(() => {
    setSelected(initialSession);
  }, [initialSession]);

  useEffect(() => {
    refreshSessions();
    api<AgentSummary[]>("/agents").then(setAgents).catch(() => {});
  }, [refreshSessions]);

  // Load a session's history, then subscribe live from the last persisted event.
  useEffect(() => {
    unsubRef.current();
    if (!selected) {
      setSession(null);
      setThread(emptyThread());
      return;
    }
    let cancelled = false;
    api<SessionDetail>(`/sessions/${selected}`)
      .then((d) => {
        if (cancelled) return;
        setSession(d.session);
        const state = reduceAll(d.events);
        const open = d.runs.find((r) => r.status === "running" || r.status === "awaiting_approval" || r.status === "queued");
        if (open) {
          state.activeRunId = open.id;
          state.status = open.status === "awaiting_approval" ? "awaiting_approval" : "running";
        } else {
          state.status = "idle";
          state.activeRunId = undefined;
        }
        setThread(state);
        unsubRef.current = streamSession(d.session.id, state.lastEventId, (ev) => setThread((s) => reduceEvent(s, ev)));
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      unsubRef.current();
    };
  }, [selected]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread.items.length, thread.live.text]);

  useEffect(() => {
    if (thread.status === "idle") refreshSessions();
  }, [thread.status, refreshSessions]);

  async function startWith(slug: string, ws?: string) {
    setError(null);
    try {
      const s = await api<Session>("/sessions", { method: "POST", json: { agent: slug, workspace: ws || undefined } });
      await refreshSessions();
      location.hash = `#/chat/${s.id}`;
      setSelected(s.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const newSession = () => startWith(agentForNew, workspace);

  async function send() {
    if (!session || !input.trim()) return;
    const text = input;
    setInput("");
    setError(null);
    try {
      await api(`/sessions/${session.id}/runs`, { method: "POST", json: { input: text } });
    } catch (e) {
      setError((e as Error).message);
      setInput(text);
    }
  }

  async function decide(item: Extract<ThreadItem, { kind: "approval" }>, decision: "approve" | "deny") {
    try {
      await api(`/runs/${item.runId}/approvals/${item.callId}`, { method: "POST", json: { decision } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function cancel() {
    if (!thread.activeRunId) return;
    try {
      await api(`/runs/${thread.activeRunId}/cancel`, { method: "POST" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeSession(id: string) {
    await api(`/sessions/${id}`, { method: "DELETE" });
    if (selected === id) {
      setSelected(undefined);
      location.hash = "#/chat";
    }
    refreshSessions();
  }

  const busy = thread.status !== "idle";

  return (
    <div className="split">
      <aside className="side">
        <h3>Build an agent</h3>
        <button
          className="primary"
          style={{ width: "100%", marginBottom: 6 }}
          onClick={() => startWith("agent-builder")}
          disabled={!agents.some((a) => a.slug === "agent-builder")}
        >
          Describe an agent in chat
        </button>
        <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
          Say what you want it to do. The builder picks a model, tools, and skills, then saves it for you.
        </div>
        <h3>New session</h3>
        <label className="field">
          <span>Agent</span>
          <select value={agentForNew} onChange={(e) => setAgentForNew(e.target.value)}>
            {agents.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name} (v{a.version})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Workspace directory (optional)</span>
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="defaults to a scratch folder" />
        </label>
        <button className="primary" onClick={newSession} style={{ width: "100%" }}>
          Start session
        </button>
        <h3 style={{ marginTop: 18 }}>Sessions</h3>
        {sessions.map((s) => (
          <a key={s.id} className={`list-item ${s.id === selected ? "active" : ""}`} href={`#/chat/${s.id}`} onClick={() => setSelected(s.id)}>
            <div>{s.title}</div>
            <div className="sub">
              {s.agentSlug} v{s.agentVersion} · {new Date(s.updatedAt).toLocaleString()}
            </div>
          </a>
        ))}
      </aside>
      <section className="content">
        {!session ? (
          <div className="empty">Start a session or pick one on the left.</div>
        ) : (
          <>
            <div className="scroll" ref={scrollRef}>
              <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
                {session.agentSlug} v{session.agentVersion} · workspace <span className="mono">{session.workspace}</span>
                <button style={{ float: "right" }} className="danger" onClick={() => removeSession(session.id)}>
                  Delete session
                </button>
              </div>
              {thread.items.map((item) => (
                <Item key={item.key} item={item} onDecide={decide} />
              ))}
              {(thread.live.text || thread.live.reasoning) && (
                <div className="msg assistant">
                  <div className="who">assistant</div>
                  {thread.live.reasoning && <div className="reasoning">{thread.live.reasoning}</div>}
                  <div className="body cursor">{thread.live.text}</div>
                </div>
              )}
              {busy && !thread.live.text && thread.status === "running" && <div className="muted cursor">thinking</div>}
            </div>
            <div className="composer">
              {error && <div className="issue error">{error}</div>}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={busy ? "Run in progress…" : "Message the agent. Enter to send, Shift+Enter for a newline."}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!busy) send();
                  }
                }}
              />
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" onClick={send} disabled={busy || !input.trim()}>
                  Send
                </button>
                {busy && (
                  <button className="danger" onClick={cancel}>
                    Cancel run
                  </button>
                )}
                <div className="meta">
                  <span>status: {thread.status}</span>
                  <span>
                    tokens: {thread.usage.inputTokens} in / {thread.usage.outputTokens} out
                  </span>
                  <span>cost: ${thread.costUsd.toFixed(4)}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Item({ item, onDecide }: { item: ThreadItem; onDecide: (i: Extract<ThreadItem, { kind: "approval" }>, d: "approve" | "deny") => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          <div className="who">you</div>
          <div className="body">{item.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="msg assistant">
          <div className="who">assistant</div>
          {item.reasoning && <div className="reasoning">{item.reasoning}</div>}
          <div className="body">{item.text}</div>
        </div>
      );
    case "tool":
      return (
        <div className="msg tool">
          <details>
            <summary>
              {item.output === undefined ? "⏳" : item.isError ? "✗" : "✓"} {item.name}
              {item.durationMs !== undefined ? ` · ${item.durationMs} ms` : ""}
            </summary>
            <div className="muted">input</div>
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
            {item.output !== undefined && (
              <>
                <div className="muted">output</div>
                <pre className={item.isError ? "err" : ""}>{item.output}</pre>
              </>
            )}
          </details>
        </div>
      );
    case "approval":
      return (
        <div className="msg approval">
          <div className="card">
            <div>
              <strong>Approval needed:</strong> {item.name}
            </div>
            <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
              {JSON.stringify(item.input, null, 2)}
            </pre>
            {item.decision ? (
              <div className="muted">{item.decision === "approve" ? "Approved" : "Denied"}</div>
            ) : (
              <div className="row">
                <button className="primary" onClick={() => onDecide(item, "approve")}>
                  Approve
                </button>
                <button className="danger" onClick={() => onDecide(item, "deny")}>
                  Deny
                </button>
              </div>
            )}
          </div>
        </div>
      );
    case "notice":
      return (
        <div className={`msg notice ${item.level}`}>
          <div className="body">{item.text}</div>
        </div>
      );
  }
}
