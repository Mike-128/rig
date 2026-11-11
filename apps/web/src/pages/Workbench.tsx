import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSummary, ApprovalDecision, PermissionMode, RunEvent, Session, SkillSummary } from "@rig/core/types";
import { api, streamSession } from "../api";
import { BUILTIN_COMMANDS, Composer, type ComposerHandle, type SlashCommand } from "../components/Composer";
import { MODE_HELP, MODE_LABEL, NewSessionDialog } from "../components/NewSession";
import { ToolCard } from "../components/ToolCard";
import { desktop, modKey, modLabel } from "../desktop";
import { emptyThread, reduceAll, reduceEvent, type ThreadItem, type ThreadState, type ToolItem } from "../events";
import { Markdown } from "../markdown";

interface SessionDetail {
  session: Session;
  runs: { id: string; status: string }[];
  events: RunEvent[];
}

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];
const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function WorkbenchPage({ sessionId, home, ready }: { sessionId?: string; home?: string; ready?: boolean }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [thread, setThread] = useState<ThreadState>(emptyThread());
  const [steering, setSteering] = useState<string[]>([]);
  const [dialog, setDialog] = useState<null | { folder?: string }>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem("rig.sidebar") !== "closed");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const composer = useRef<ComposerHandle>(null);
  const unsub = useRef<() => void>(() => {});

  const refreshSessions = useCallback(() => api<Session[]>("/sessions").then(setSessions).catch(() => {}), []);

  useEffect(() => {
    refreshSessions();
    api<AgentSummary[]>("/agents").then(setAgents).catch(() => {});
  }, [refreshSessions]);

  // Skills visible from this folder: project skills included, so /commands match what the agent sees.
  useEffect(() => {
    const ws = session?.workspace ? `?workspace=${encodeURIComponent(session.workspace)}` : "";
    api<{ skills: SkillSummary[] }>(`/skills${ws}`)
      .then((r) => setSkills(r.skills))
      .catch(() => {});
  }, [session?.workspace]);

  // Load history, then follow live events from the last persisted one.
  useEffect(() => {
    unsub.current();
    setSteering([]);
    setError(null);
    if (!sessionId) {
      setSession(null);
      setThread(emptyThread());
      return;
    }
    let cancelled = false;
    api<SessionDetail>(`/sessions/${sessionId}`)
      .then((d) => {
        if (cancelled) return;
        setSession(d.session);
        const state = reduceAll(d.events);
        const open = d.runs.find((r) => ["running", "awaiting_approval", "queued"].includes(r.status));
        state.status = open ? (open.status === "awaiting_approval" ? "awaiting_approval" : "running") : "idle";
        state.activeRunId = open?.id;
        setThread(state);
        stick.current = true;
        unsub.current = streamSession(d.session.id, state.lastEventId, (ev) => setThread((s) => reduceEvent(s, ev)));
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      unsub.current();
    };
  }, [sessionId]);

  // Steering messages leave the queue once the agent has received them.
  useEffect(() => {
    if (!steering.length) return;
    if (thread.status === "idle") {
      setSteering([]);
      return;
    }
    const received = new Set(thread.items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text));
    setSteering((q) => q.filter((t) => !received.has(t)));
  }, [thread.items, thread.status, steering.length]);

  useEffect(() => {
    if (thread.status === "idle") refreshSessions();
  }, [thread.status, refreshSessions]);

  // Follow the bottom while the user is there; leave them alone when they scroll up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread.items, thread.live.text, thread.live.reasoning]);

  const pendingApprovals = useMemo(() => thread.items.filter((i): i is ToolItem => i.kind === "tool" && i.status === "awaiting_approval"), [thread.items]);
  const running = thread.status !== "idle";

  const commands: SlashCommand[] = useMemo(
    () => [...BUILTIN_COMMANDS, ...skills.filter((s) => !BUILTIN_COMMANDS.some((b) => b.name === s.name)).map((s) => ({ name: s.name, description: s.description, kind: "skill" as const }))],
    [skills],
  );

  const patch = useCallback(
    async (body: Partial<{ mode: PermissionMode; title: string; agent: string; removeRule: string }>) => {
      if (!session) return;
      try {
        setSession(await api<Session>(`/sessions/${session.id}`, { method: "PATCH", json: body }));
        if (body.title || body.agent) refreshSessions();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [session, refreshSessions],
  );

  const cycleMode = useCallback(() => {
    if (!session) return;
    patch({ mode: MODES[(MODES.indexOf(session.mode) + 1) % MODES.length] });
  }, [session, patch]);

  const stop = useCallback(async () => {
    if (thread.activeRunId) await api(`/runs/${thread.activeRunId}/cancel`, { method: "POST" }).catch(() => {});
  }, [thread.activeRunId]);

  const decide = useCallback(
    async (t: ToolItem, decision: ApprovalDecision) => {
      try {
        await api(`/runs/${t.runId}/approvals/${t.callId}`, { method: "POST", json: { decision } });
      } catch (e) {
        setError((e as Error).message);
      }
      composer.current?.focus();
    },
    [],
  );

  async function send(text: string) {
    setError(null);
    const cmd = text.match(/^\/(\w[\w-]*)(?:\s+(.*))?$/s);
    const builtin = cmd && BUILTIN_COMMANDS.find((c) => c.name === cmd[1]);
    if (builtin) return runBuiltin(builtin.name, cmd![2]?.trim() ?? "");
    if (!session) return;
    try {
      const res = await api<{ steered?: boolean }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: text } });
      if (res.steered) setSteering((q) => [...q, text]);
      else setThread((s) => ({ ...s, status: "running" }));
      stick.current = true;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runBuiltin(name: string, arg: string) {
    switch (name) {
      case "clear":
        setDialog({ folder: session && !isScratch(session) ? session.workspace : undefined });
        return;
      case "compact":
        if (!session) return;
        try {
          await api(`/sessions/${session.id}/compact`, { method: "POST" });
          setThread((s) => ({ ...s, status: "running" }));
        } catch (e) {
          setError((e as Error).message);
        }
        return;
      case "mode": {
        const m = MODES.find((x) => x.toLowerCase() === arg.toLowerCase());
        if (m) patch({ mode: m });
        else cycleMode();
        return;
      }
      case "agent":
        if (arg && agents.some((a) => a.slug === arg)) patch({ agent: arg });
        else setError(`Agents: ${agents.map((a) => a.slug).join(", ")}. Use /agent <slug>.`);
        return;
      case "skills":
        location.hash = "#/skills";
        return;
      case "help":
        setShowHelp(true);
        return;
    }
  }

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modKey(e) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setDialog({});
      } else if (modKey(e) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebar((v) => {
          localStorage.setItem("rig.sidebar", v ? "closed" : "open");
          return !v;
        });
      } else if (modKey(e) && e.key === "/") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isScratch = (s: Session) => Boolean(home) && s.workspace.toLowerCase().startsWith(`${home}`.toLowerCase());

  const groups = useMemo(() => {
    const q = filter.toLowerCase();
    const map = new Map<string, Session[]>();
    for (const s of sessions) {
      if (q && !s.title.toLowerCase().includes(q) && !s.workspace.toLowerCase().includes(q)) continue;
      const key = isScratch(s) ? "" : s.workspace;
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : 0));
  }, [sessions, filter, home]);

  const contextWindow = thread.contextWindow ?? 200_000;
  const contextPct = Math.min(100, Math.round((thread.contextTokens / contextWindow) * 100));
  const openTodos = thread.todos.length > 0 && thread.todos.some((t) => t.status !== "completed");
  const activeTodo = thread.todos.find((t) => t.status === "in_progress");

  return (
    <div className={`workbench ${sidebar ? "" : "no-side"}`}>
      {sidebar && (
        <aside className="wb-side">
          <button className="block" onClick={() => setDialog({})} title={`New session (${modLabel}+N)`}>
            + New session
          </button>
          <input className="search" placeholder="Filter sessions" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="sessions">
            {groups.map(([ws, list]) => (
              <div key={ws || "chats"} className="group">
                <div className="group-head" title={ws || "Chats without a project folder"}>
                  <span>{ws ? basename(ws) : "Chats"}</span>
                  {ws && (
                    <button className="ghost tiny" title="New session in this folder" onClick={() => setDialog({ folder: ws })}>
                      +
                    </button>
                  )}
                </div>
                {list.map((s) => (
                  <a key={s.id} href={`#/s/${s.id}`} className={`session-item ${s.id === sessionId ? "active" : ""}`}>
                    <span className="title">{s.title}</span>
                    <span className="when">{relTime(s.updatedAt)}</span>
                  </a>
                ))}
              </div>
            ))}
            {!sessions.length && <div className="muted small pad">No sessions yet.</div>}
          </div>
        </aside>
      )}

      <section className="wb-main">
        {!session ? (
          <Welcome ready={ready} onNew={(folder) => setDialog({ folder })} />
        ) : (
          <>
            <header className="wb-head">
              <button className="ghost tiny" title={`Toggle sidebar (${modLabel}+B)`} onClick={() => setSidebar((v) => !v)}>
                ☰
              </button>
              <div className="titles">
                <div
                  className="title"
                  title="Rename"
                  onDoubleClick={() => {
                    const t = prompt("Session title", session.title);
                    if (t?.trim()) patch({ title: t.trim() });
                  }}
                >
                  {session.title}
                </div>
                {!isScratch(session) && (
                  <button className="path mono ghost" title={desktop ? "Open folder" : session.workspace} onClick={() => desktop?.openPath(session.workspace)}>
                    {session.workspace}
                  </button>
                )}
              </div>
              <select className="agent" value={session.agentSlug} onChange={(e) => patch({ agent: e.target.value })} title="Agent for this session">
                {agents.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button className={`mode mode-${session.mode}`} onClick={cycleMode} title={`${MODE_HELP[session.mode]} (Shift+Tab to cycle)`}>
                {MODE_LABEL[session.mode]}
              </button>
            </header>

            <div
              className="thread"
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {thread.items.length === 0 && !running && (
                <div className="empty">
                  {isScratch(session) ? "Ask anything." : `Working in ${basename(session.workspace)}. Describe a task, mention files with @, or type / for commands.`}
                </div>
              )}
              {thread.items.map((it) => (
                <Item key={it.key} it={it} onDecide={decide} />
              ))}
              {running && <LiveTurn thread={thread} />}
            </div>

            <footer className="wb-foot">
              {openTodos && (
                <div className="todos">
                  {thread.todos.map((t, i) => (
                    <div key={i} className={`todo ${t.status}`}>
                      <span className="box">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"}</span>
                      {t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
                    </div>
                  ))}
                </div>
              )}
              {pendingApprovals[0] && <ApprovalBar t={pendingApprovals[0]} more={pendingApprovals.length - 1} onDecide={decide} />}
              {steering.map((s, i) => (
                <div key={i} className="queued">
                  <span className="pill">queued</span> {s}
                </div>
              ))}
              {error && (
                <div className="issue error" onClick={() => setError(null)}>
                  {error}
                </div>
              )}
              <Composer
                ref={composer}
                sessionId={session.id}
                running={running}
                mode={session.mode}
                commands={commands}
                placeholder={running ? "Add a message; the agent reads it at its next step. Esc to stop." : "Message, @file, or /command"}
                onSend={send}
                onStop={stop}
                onCycleMode={cycleMode}
              />
              <div className="statusline">
                <span>{thread.model ?? session.agentSlug}</span>
                <span title={`${thread.contextTokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens in the last request`} className={contextPct >= 70 ? "warn" : ""}>
                  context {contextPct}%<span className="meter"><span style={{ width: `${contextPct}%` }} /></span>
                </span>
                <span>
                  {fmtTokens(thread.usage.inputTokens + (thread.usage.cachedInputTokens ?? 0))} in, {fmtTokens(thread.usage.outputTokens)} out
                </span>
                {thread.costUsd > 0 && <span>${thread.costUsd.toFixed(thread.costUsd < 1 ? 3 : 2)}</span>}
                {running && activeTodo && <span className="active-todo">{activeTodo.activeForm ?? activeTodo.content}</span>}
                <span className="spacer" />
                <span className="hint">Shift+Tab mode, Esc stop, {modLabel}+/ help</span>
              </div>
            </footer>
          </>
        )}
      </section>

      {dialog && (
        <NewSessionDialog
          agents={agents}
          folder={dialog.folder}
          onClose={() => setDialog(null)}
          onCreated={(s) => {
            setDialog(null);
            refreshSessions();
            location.hash = `#/s/${s.id}`;
          }}
        />
      )}
      {showHelp && <Help onClose={() => setShowHelp(false)} commands={commands} />}
    </div>
  );
}

function Item({ it, onDecide }: { it: ThreadItem; onDecide: (t: ToolItem, d: ApprovalDecision) => void }) {
  switch (it.kind) {
    case "user":
      return (
        <div className={`turn user ${it.steered ? "steered" : ""}`}>
          {it.steered && <span className="pill">sent while working</span>}
          <div className="bubble">{it.display ?? it.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="turn assistant">
          {it.reasoning && (
            <details className="reasoning">
              <summary>Thinking</summary>
              <Markdown text={it.reasoning} />
            </details>
          )}
          {it.text && <Markdown text={it.text} />}
        </div>
      );
    case "tool":
      return (
        <div className="turn tool-turn">
          <ToolCard t={it} />
          {it.status === "awaiting_approval" && (
            <div className="inline-approve">
              <button className="primary" onClick={() => onDecide(it, "approve")}>
                Allow
              </button>
              <button onClick={() => onDecide(it, "always")}>Always allow</button>
              <button className="danger" onClick={() => onDecide(it, "deny")}>
                Deny
              </button>
            </div>
          )}
        </div>
      );
    case "compacted":
      return (
        <details className="turn compacted">
          <summary>
            Conversation compacted ({Math.round(it.tokensBefore / 1000)}k tokens summarized). The agent continues from the summary.
          </summary>
          <Markdown text={it.summary} />
        </details>
      );
    case "notice":
      return <div className={`turn notice ${it.level}`}>{it.text}</div>;
  }
}

function LiveTurn({ thread }: { thread: ThreadState }) {
  const [t0] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.floor((Date.now() - t0) / 1000);
  let busyTool: ToolItem | undefined;
  for (const i of thread.items) if (i.kind === "tool" && i.status === "running") busyTool = i;
  return (
    <div className="turn assistant live">
      {thread.live.reasoning && !thread.live.text && <div className="thinking muted">{thread.live.reasoning.slice(-400)}</div>}
      {thread.live.text && <Markdown text={thread.live.text} className="cursor" />}
      {!thread.live.text && thread.status === "running" && (
        <div className="working">
          <span className="spinner" />
          {thread.live.tool ? `Preparing ${thread.live.tool}…` : busyTool ? `Running ${busyTool.name}…` : "Working…"} <span className="muted">{secs}s</span>
        </div>
      )}
    </div>
  );
}

function ApprovalBar({ t, more, onDecide }: { t: ToolItem; more: number; onDecide: (t: ToolItem, d: ApprovalDecision) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [t.callId]);
  const cmd = t.name === "shell" ? String((t.input as { command?: string })?.command ?? "") : "";
  const scope = t.name === "shell" ? `${cmd.split(/\s+/).slice(0, /^[a-z][\w.-]*$/i.test(cmd.split(/\s+/)[1] ?? "") ? 2 : 1).join(" ")} commands` : `${t.name} in this session`;
  return (
    <div
      className="approval-bar"
      tabIndex={0}
      ref={ref}
      onKeyDown={(e) => {
        const k = e.key.toLowerCase();
        if (k === "enter" || k === "y" || k === "1") onDecide(t, "approve");
        else if (k === "a" || k === "2") onDecide(t, "always");
        else if (k === "escape" || k === "n" || k === "3") onDecide(t, "deny");
        else return;
        e.preventDefault();
      }}
    >
      <div className="q">
        Allow <b>{t.name}</b>
        {cmd && <code className="mono"> {cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd}</code>}?{more > 0 && <span className="muted"> (+{more} more waiting)</span>}
      </div>
      <div className="row">
        <button className="primary" onClick={() => onDecide(t, "approve")}>
          Allow <kbd>Enter</kbd>
        </button>
        <button onClick={() => onDecide(t, "always")} title={`Stop asking for ${scope}`}>
          Always allow {scope} <kbd>A</kbd>
        </button>
        <button className="danger" onClick={() => onDecide(t, "deny")}>
          Deny <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}

function Welcome({ onNew, ready }: { onNew: (folder?: string) => void; ready?: boolean }) {
  const [recent, setRecent] = useState<{ path: string }[]>([]);
  useEffect(() => {
    api<{ path: string }[]>("/projects").then(setRecent).catch(() => {});
  }, []);
  return (
    <div className="welcome">
      <h1>Rig</h1>
      <p className="muted">Open a project folder to work on code with an agent, or start a chat.</p>
      {ready === false && (
        <div className="setup-callout">
          <div>
            <strong>Connect a model first.</strong>
            <div className="muted">Agents need a model to think with. Add a key for Anthropic, OpenAI, Google, your gateway, or a local server; it takes a minute.</div>
          </div>
          <a className="btn btn-primary big" href="#/settings/setup">
            Set up Rig
          </a>
        </div>
      )}
      <div className="row center">
        <button className={`big ${ready === false ? "" : "primary"}`} onClick={() => onNew()}>
          Open a project…
        </button>
        <button className="big" onClick={() => onNew("")}>
          New chat
        </button>
      </div>
      {recent.length > 0 && (
        <div className="recent wide">
          <h3>Recent projects</h3>
          {recent.slice(0, 8).map((r) => (
            <button key={r.path} className="recent-item" onClick={() => onNew(r.path)}>
              <span>{basename(r.path)}</span>
              <span className="muted mono">{r.path}</span>
            </button>
          ))}
        </div>
      )}
      <p className="muted small">
        {modLabel}+N new session, {modLabel}+B sidebar, {modLabel}+/ shortcuts
      </p>
    </div>
  );
}

function Help({ onClose, commands }: { onClose: () => void; commands: SlashCommand[] }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Shortcuts</h2>
        <table className="keys">
          <tbody>
            {[
              ["Enter", "Send (while the agent works: steer it at its next step)"],
              ["Shift+Enter", "New line"],
              ["Esc", "Stop the agent"],
              ["Shift+Tab", "Cycle permissions: ask, accept edits, plan, auto"],
              ["↑ / ↓", "Previous messages (in an empty box)"],
              ["/", "Commands and skills"],
              ["@", "Mention a file"],
              ["Enter / A / Esc", "Approve, always allow, or deny, when asked"],
              [`${modLabel}+N`, "New session"],
              [`${modLabel}+B`, "Toggle sidebar"],
            ].map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Commands</h3>
        <div className="cmds">
          {commands.map((c) => (
            <div key={c.name}>
              <span className="mono">/{c.name}</span> <span className="muted">{c.description}</span>
            </div>
          ))}
        </div>
        <div className="row end">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
