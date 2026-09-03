import type { Run, RunEvent, RunEventBody, RunStatus, Session, SessionKind, Usage } from "@rig/core";
import { json, nowIso, type Db } from "../db";

interface SessionRow {
  id: string;
  kind: string;
  agent_slug: string;
  agent_version: number;
  workspace: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  session_id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  usage: string | null;
  cost_usd: number | null;
  error: string | null;
}

interface EventRow {
  id: number;
  run_id: string;
  session_id: string;
  type: string;
  payload: string;
  ts: string;
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  kind: r.kind as SessionKind,
  agentSlug: r.agent_slug,
  agentVersion: r.agent_version,
  workspace: r.workspace,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow): Run => ({
  id: r.id,
  sessionId: r.session_id,
  status: r.status as RunStatus,
  createdAt: r.created_at,
  startedAt: r.started_at ?? undefined,
  endedAt: r.ended_at ?? undefined,
  usage: json<Usage | undefined>(r.usage, undefined),
  costUsd: r.cost_usd ?? undefined,
  error: r.error ?? undefined,
});

const toEvent = (r: EventRow): RunEvent => ({
  ...(JSON.parse(r.payload) as RunEventBody),
  id: r.id,
  runId: r.run_id,
  sessionId: r.session_id,
  ts: r.ts,
});

export class SessionStore {
  constructor(private db: Db) {}

  // sessions
  listSessions(limit = 100): Session[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as SessionRow[]).map(toSession);
  }

  getSession(id: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as SessionRow | undefined;
    return r ? toSession(r) : undefined;
  }

  createSession(s: Omit<Session, "createdAt" | "updatedAt">): Session {
    const t = nowIso();
    this.db
      .prepare("INSERT INTO sessions (id, kind, agent_slug, agent_version, workspace, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(s.id, s.kind, s.agentSlug, s.agentVersion, s.workspace, s.title, t, t);
    return this.getSession(s.id)!;
  }

  touchSession(id: string, title?: string): void {
    if (title) this.db.prepare("UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?").run(nowIso(), title, id);
    else this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM runs WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // runs
  createRun(id: string, sessionId: string): Run {
    this.db.prepare("INSERT INTO runs (id, session_id, status, created_at) VALUES (?,?,?,?)").run(id, sessionId, "queued", nowIso());
    return this.getRun(id)!;
  }

  getRun(id: string): Run | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
    return r ? toRun(r) : undefined;
  }

  listRuns(sessionId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at").all(sessionId) as unknown as RunRow[]).map(toRun);
  }

  updateRun(id: string, patch: Partial<Pick<Run, "status" | "startedAt" | "endedAt" | "usage" | "costUsd" | "error">>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.status) (sets.push("status = ?"), vals.push(patch.status));
    if (patch.startedAt) (sets.push("started_at = ?"), vals.push(patch.startedAt));
    if (patch.endedAt) (sets.push("ended_at = ?"), vals.push(patch.endedAt));
    if (patch.usage) (sets.push("usage = ?"), vals.push(JSON.stringify(patch.usage)));
    if (patch.costUsd !== undefined) (sets.push("cost_usd = ?"), vals.push(patch.costUsd));
    if (patch.error !== undefined) (sets.push("error = ?"), vals.push(patch.error));
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as (string | number | null)[]));
  }

  /** Mark runs left running by a previous process as failed. */
  failInterrupted(): number {
    const r = this.db
      .prepare("UPDATE runs SET status = 'failed', error = 'Interrupted by runtime restart', ended_at = ? WHERE status IN ('queued','running','awaiting_approval')")
      .run(nowIso());
    return Number(r.changes);
  }

  // events
  appendEvent(runId: string, sessionId: string, body: RunEventBody, ts: string): RunEvent {
    const r = this.db.prepare("INSERT INTO events (run_id, session_id, type, payload, ts) VALUES (?,?,?,?,?)").run(runId, sessionId, body.type, JSON.stringify(body), ts);
    return { ...body, id: Number(r.lastInsertRowid), runId, sessionId, ts };
  }

  sessionEvents(sessionId: string, afterId = 0): RunEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id").all(sessionId, afterId) as unknown as EventRow[]).map(toEvent);
  }

  runEvents(runId: string, afterId = 0): RunEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id").all(runId, afterId) as unknown as EventRow[]).map(toEvent);
  }
}
