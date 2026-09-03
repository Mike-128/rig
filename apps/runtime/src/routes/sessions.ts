import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectMessages, TERMINAL_EVENTS, type RunEvent } from "@harness/core";
import type { AppContext } from "../context";
import { newId } from "../ids";

const CreateSession = z.object({
  agent: z.string().min(1),
  workspace: z.string().optional(),
  kind: z.enum(["chat", "workbench", "task"]).optional(),
  title: z.string().optional(),
});

export function sessionRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/sessions", (c) => c.json(app.sessions.listSessions()));

  r.post("/sessions", async (c) => {
    const parsed = CreateSession.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const b = parsed.data;
    const agent = app.agents.get(b.agent);
    if (!agent) return c.json({ error: `agent "${b.agent}" not found` }, 404);
    const id = newId("sess");
    const workspace = b.workspace ? path.resolve(b.workspace) : path.join(app.config.workspacesDir, id);
    mkdirSync(workspace, { recursive: true });
    const session = app.sessions.createSession({
      id,
      kind: b.kind ?? "chat",
      agentSlug: agent.slug,
      agentVersion: agent.version,
      workspace,
      title: b.title ?? "New session",
    });
    return c.json(session, 201);
  });

  r.get("/sessions/:id", (c) => {
    const s = app.sessions.getSession(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    const events = app.sessions.sessionEvents(s.id);
    return c.json({ session: s, runs: app.sessions.listRuns(s.id), events, messages: projectMessages(events) });
  });

  r.delete("/sessions/:id", (c) => {
    app.sessions.deleteSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  r.post("/sessions/:id/runs", async (c) => {
    const s = app.sessions.getSession(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    const b = z.object({ input: z.string().min(1) }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "input is required" }, 400);
    const busy = app.sessions.listRuns(s.id).some((run) => app.runs.isActive(run.id));
    if (busy) return c.json({ error: "a run is already active on this session" }, 409);
    return c.json(app.runs.submit(s, b.data.input), 202);
  });

  /** Live event stream for a session, resumable with ?after=<event id>. */
  r.get("/sessions/:id/stream", (c) => {
    const s = app.sessions.getSession(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      let last = after;
      const send = (ev: RunEvent) =>
        stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: ev.id !== undefined ? String(ev.id) : undefined });
      for (const ev of app.sessions.sessionEvents(s.id, after)) {
        await send(ev);
        last = ev.id ?? last;
      }
      const queue: RunEvent[] = [];
      let wake: (() => void) | undefined;
      const unsub = app.runs.subscribe(`session:${s.id}`, (ev) => {
        if (ev.id !== undefined && ev.id <= last) return;
        queue.push(ev);
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      try {
        while (!stream.aborted) {
          if (!queue.length) await new Promise<void>((res) => (wake = res));
          wake = undefined;
          while (queue.length) {
            const ev = queue.shift()!;
            await send(ev);
            if (ev.id !== undefined) last = ev.id;
          }
        }
      } finally {
        unsub();
      }
    });
  });

  r.get("/runs/:id", (c) => {
    const run = app.sessions.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ ...run, pendingApprovals: app.runs.pendingApprovals(run.id) });
  });

  r.get("/runs/:id/events", (c) => {
    const run = app.sessions.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      let done = false;
      let last = after;
      const send = async (ev: RunEvent) => {
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: ev.id !== undefined ? String(ev.id) : undefined });
        if (ev.id !== undefined) last = ev.id;
        if (TERMINAL_EVENTS.has(ev.type)) done = true;
      };
      for (const ev of app.sessions.runEvents(run.id, after)) await send(ev);
      if (done || !app.runs.isActive(run.id)) return;
      const queue: RunEvent[] = [];
      let wake: (() => void) | undefined;
      const unsub = app.runs.subscribe(`run:${run.id}`, (ev) => {
        if (ev.id !== undefined && ev.id <= last) return;
        queue.push(ev);
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      try {
        while (!done && !stream.aborted) {
          if (!queue.length) await new Promise<void>((res) => (wake = res));
          wake = undefined;
          while (queue.length) await send(queue.shift()!);
        }
      } finally {
        unsub();
      }
    });
  });

  r.post("/runs/:id/approvals/:callId", async (c) => {
    const b = z.object({ decision: z.enum(["approve", "deny"]) }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "decision must be approve or deny" }, 400);
    const ok = app.runs.approve(c.req.param("id"), c.req.param("callId"), b.data.decision);
    return ok ? c.json({ ok: true }) : c.json({ error: "no pending approval with that id" }, 404);
  });

  r.post("/runs/:id/cancel", (c) => {
    const ok = app.runs.cancel(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "run is not active" }, 404);
  });

  return r;
}
