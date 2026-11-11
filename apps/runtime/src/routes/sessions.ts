import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { existsSync, readFileSync, statSync } from "node:fs";
import { PERMISSION_MODES, projectMessages, resolveInWorkspace, TERMINAL_EVENTS, walkFiles, type PermissionMode, type RunEvent, type Session } from "@rig/core";
import type { AppContext } from "../context";
import { newId } from "../ids";

/** Skill invocations look like "/name rest of the request". */
const SLASH = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/;

/** Expand "/skill args" into a turn carrying the skill's instructions, as Claude Code does. */
function expandSlashSkill(app: AppContext, session: Session, input: string): { input: string; display?: string } {
  const m = input.trim().match(SLASH);
  if (!m) return { input };
  const skill = app.skills.get(m[1], session.workspace);
  if (!skill) return { input };
  const files = skill.files.length ? `\n\nThe skill's folder is ${skill.dir}, with these resource files: ${skill.files.join(", ")}.` : "";
  return {
    display: input,
    input: `The user invoked the /${skill.name} skill. Follow its instructions for this request.\n\n<skill name="${skill.name}">\n${skill.body}\n</skill>${files}\n\nThe user's request: ${m[2]?.trim() || "(no further detail; apply the skill to the current work)"}`,
  };
}

const FILE_INDEX_LIMIT = 20_000;
const MENTION_MAX_FILES = 10;
const MENTION_MAX_CHARS = 100_000;

/**
 * "@path" mentions of files in the session's folder attach the file's contents to the turn, so the
 * agent starts with what the user pointed at instead of spending a call to read it.
 */
function attachMentions(session: Session, turn: { input: string; display?: string }): { input: string; display?: string } {
  const paths = [...new Set([...turn.input.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1].replace(/[.,;:!?)]+$/, "")))];
  const blocks: string[] = [];
  for (const rel of paths.slice(0, MENTION_MAX_FILES)) {
    let abs: string;
    try {
      abs = resolveInWorkspace(session.workspace, rel);
    } catch {
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString("utf8");
    const body = text.length > MENTION_MAX_CHARS ? `${text.slice(0, MENTION_MAX_CHARS)}\n[truncated; read the rest with file_read]` : text;
    blocks.push(`<file path="${rel}">\n${body}\n</file>`);
  }
  if (!blocks.length) return turn;
  return { input: `${turn.input}\n\nFiles the user mentioned:\n\n${blocks.join("\n\n")}`, display: turn.display ?? turn.input };
}
const MODE_ENUM = z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]);

const CreateSession = z.object({
  agent: z.string().min(1),
  workspace: z.string().optional(),
  kind: z.enum(["chat", "workbench", "task"]).optional(),
  title: z.string().optional(),
  mode: MODE_ENUM.optional(),
});

const PatchSession = z.object({
  title: z.string().min(1).max(200).optional(),
  mode: MODE_ENUM.optional(),
  agent: z.string().min(1).optional(),
  removeRule: z.string().optional(),
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
    if (b.workspace && (!existsSync(workspace) || !statSync(workspace).isDirectory())) {
      return c.json({ error: `folder not found: ${workspace}` }, 400);
    }
    mkdirSync(workspace, { recursive: true });
    const session = app.sessions.createSession({
      id,
      kind: b.kind ?? "chat",
      agentSlug: agent.slug,
      agentVersion: agent.version,
      workspace,
      title: b.title ?? "New session",
      mode: b.mode,
    });
    return c.json(session, 201);
  });

  /** Folders sessions have worked in, for the "open recent" list. Scratch workspaces are left out. */
  r.get("/projects", (c) => c.json(app.sessions.recentWorkspaces(app.config.workspacesDir).filter((p) => existsSync(p.path))));

  r.patch("/sessions/:id", async (c) => {
    const s = app.sessions.getSession(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    const parsed = PatchSession.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const b = parsed.data;
    if (b.title) app.sessions.setTitle(s.id, b.title);
    if (b.mode) app.sessions.setMode(s.id, b.mode);
    if (b.removeRule) app.sessions.removeAllowRule(s.id, b.removeRule);
    if (b.agent) {
      const agent = app.agents.get(b.agent);
      if (!agent) return c.json({ error: `agent "${b.agent}" not found` }, 404);
      app.sessions.setAgent(s.id, agent.slug, agent.version);
    }
    return c.json(app.sessions.getSession(s.id));
  });

  /** Summarize the conversation so far into a fresh context, like /compact. */
  r.post("/sessions/:id/compact", (c) => {
    const s = app.sessions.getSession(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    if (app.runs.activeRunFor(s.id)) return c.json({ error: "wait for the current run to finish, or stop it" }, 409);
    return c.json(app.runs.submit(s, "", { compactOnly: true }), 202);
  });

  /** Fuzzy file search in the session's folder, for @mentions. */
  r.get("/sessions/:id/files", async (c) => {
    const s = app.sessions.getSession(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    const q = (c.req.query("q") ?? "").toLowerCase();
    const scored: { path: string; score: number }[] = [];
    let seen = 0;
    for await (const f of walkFiles(s.workspace, s.workspace)) {
      if (++seen > FILE_INDEX_LIMIT) break;
      const score = fuzzyScore(f.rel.toLowerCase(), q);
      if (score > 0) scored.push({ path: f.rel, score });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    return c.json(scored.slice(0, 30).map((x) => x.path));
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
    const turn = attachMentions(s, expandSlashSkill(app, s, b.data.input));
    // A message sent while the agent is working steers it: it reaches the model at the next turn boundary.
    if (app.runs.steer(s.id, turn.input)) return c.json({ steered: true, runId: app.runs.activeRunFor(s.id)?.id }, 202);
    return c.json(app.runs.submit(s, turn.input, { display: turn.display }), 202);
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
    const b = z.object({ decision: z.enum(["approve", "deny", "always"]) }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "decision must be approve, always, or deny" }, 400);
    const ok = app.runs.approve(c.req.param("id"), c.req.param("callId"), b.data.decision);
    return ok ? c.json({ ok: true }) : c.json({ error: "no pending approval with that id" }, 404);
  });

  /**
   * Everything that needs the user's attention, across sessions: approvals and finished runs.
   * The desktop shell listens here for notifications and the tray badge.
   */
  r.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: RunEvent[] = [];
      let wake: (() => void) | undefined;
      const wanted = new Set(["approval_requested", "approval_resolved", "run_started", "run_completed", "run_failed", "run_cancelled"]);
      const unsub = app.runs.subscribe("all", (ev) => {
        if (!wanted.has(ev.type)) return;
        queue.push(ev);
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ awaiting: app.runs.awaitingApproval() }) });
      try {
        while (!stream.aborted) {
          if (!queue.length) {
            // A comment every 25 s keeps proxies and the browser from closing an idle stream.
            await Promise.race([new Promise<void>((res) => (wake = res)), new Promise<void>((res) => setTimeout(res, 25_000))]);
            if (!queue.length) {
              await stream.write(": keepalive\n\n");
              continue;
            }
          }
          wake = undefined;
          while (queue.length) {
            const ev = queue.shift()!;
            const session = app.sessions.getSession(ev.sessionId);
            await stream.writeSSE({ event: ev.type, data: JSON.stringify({ ...ev, sessionTitle: session?.title, workspace: session?.workspace }) });
          }
        }
      } finally {
        unsub();
      }
    }),
  );

  r.post("/runs/:id/cancel", (c) => {
    const ok = app.runs.cancel(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "run is not active" }, 404);
  });

  return r;
}

/** Subsequence match with bonuses for basename hits and consecutive characters; 0 means no match. */
function fuzzyScore(target: string, q: string): number {
  if (!q) return 1;
  const base = target.slice(target.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 1000 - base.length;
  if (base.includes(q)) return 800 - base.length;
  if (target.includes(q)) return 600 - target.length;
  let ti = 0;
  let score = 0;
  let run = 0;
  for (const ch of q) {
    const found = target.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2;
    ti = found + 1;
  }
  return score;
}
