import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connection, RunEvent, Session } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";

/**
 * Conversations between agents: a product manager talks to a research agent, which keeps the
 * whole exchange, asks the user (through the PM's session) for approvals, and cannot be looped.
 */
let home: string;
let rt: RunningServer;
let upstream: Awaited<ReturnType<typeof startMockUpstream>>;

async function call(route: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${rt.app.config.proxyOrigin}/api${route}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api<T>(route: string, method = "GET", body?: unknown): Promise<T> {
  const res = await call(route, method, body);
  const data = await res.json();
  if (!res.ok) throw new Error(`${route}: ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}
async function settle(id: string) {
  for (let i = 0; i < 300; i++) {
    const run = await api<{ status: string; pendingApprovals: string[] }>(`/runs/${id}`);
    if (["completed", "failed", "cancelled", "awaiting_approval"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Run did not settle");
}
type SessionView = { session: Session; events: RunEvent[]; runs: { id: string; status: string }[]; conversations: { id: string; agentSlug: string }[]; parentTitle?: string };
const results = (v: SessionView) => v.events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
const conversationId = (output: string) => output.match(/\(conversation (sess_[A-Za-z0-9]+)\)/)?.[1];

async function say(sessionId: string, input: string) {
  const run = await api<{ id: string }>(`/sessions/${sessionId}/runs`, "POST", { input });
  return { id: run.id, final: await settle(run.id) };
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "rig-conversations-"));
  upstream = await startMockUpstream();
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });
  const { connection } = await api<{ connection: Connection }>("/connections", "POST", {
    name: "mock", profileId: "openai-compatible", key: GOOD_KEY, baseUrl: upstream.url,
    models: [{ id: "mock-gpt", dialect: "openai.chat", route: "/v1/chat/completions" }],
  });
  await api("/aliases/default", "PUT", { connectionId: connection.id, modelId: "mock-gpt" });
  const agent = (slug: string, name: string, extra: Record<string, unknown>) =>
    api(`/agents/${slug}`, "PUT", { name, slug, model: { alias: "default" }, instructions: `You are the ${name}.`, sandbox: 1, ...extra });
  await agent("pm", "Product manager", { description: "Owns the roadmap", tools: ["agent_message"], talksTo: ["research"] });
  await agent("research", "Research", { description: "Finds and reads sources", tools: ["file_read", "agent_message"], approvals: ["file_read"], talksTo: ["pm", "analyst"] });
  await agent("analyst", "Analyst", { tools: ["file_read"] });
});

afterAll(async () => {
  await rt?.close();
  await upstream?.close();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("conversations between agents", () => {
  it("starts a conversation, then continues it with the other agent remembering what was said", async () => {
    const pm = await api<Session>("/sessions", "POST", { agent: "pm" });
    const offset = upstream.requests.length;
    const first = await say(pm.id, "ask research: what drives churn for small customers?");
    expect(first.final.status).toBe("completed");

    let view = await api<SessionView>(`/sessions/${pm.id}`);
    const opened = results(view).at(-1)!;
    expect(opened).toMatchObject({ name: "agent_message", isError: false });
    expect(opened.output).toMatch(/^Research replied \(conversation sess_[A-Za-z0-9]+\):\n\nYou said: what drives churn for small customers\?/);
    expect(opened.output).toMatch(/To reply, call agent_message with conversation "sess_/);
    const id = conversationId(opened.output)!;

    // The PM is told who it can talk to; Research is told who is talking to it.
    const sent = upstream.requests.slice(offset).map((r) => JSON.stringify(r.body));
    expect(sent.some((b) => b.includes("## Agents you can talk to") && b.includes("- research: Research (Finds and reads sources)") && !b.includes("- analyst"))).toBe(true);
    expect(sent.some((b) => b.includes("## Conversation with Product manager"))).toBe(true);

    // The conversation is its own saved session, reached from the PM's session rather than the list.
    const convo = await api<SessionView>(`/sessions/${id}`);
    expect(convo.session).toMatchObject({ kind: "conversation", agentSlug: "research", workspace: pm.workspace, parent: { sessionId: pm.id, agentSlug: "pm", agentName: "Product manager" } });
    expect(convo.parentTitle).toBeTruthy();
    expect(view.conversations.map((c) => c.id)).toEqual([id]);
    expect((await api<Session[]>("/sessions")).some((s) => s.id === id)).toBe(false);

    const before = upstream.requests.length;
    const second = await say(pm.id, `reply to ${id}: the last four quarters, counting downgrades`);
    expect(second.final.status).toBe("completed");
    view = await api<SessionView>(`/sessions/${pm.id}`);
    expect(results(view).at(-1)!.output).toMatch(/^Research replied \(conversation .+\):\n\nYou said: the last four quarters, counting downgrades/);
    expect(view.conversations).toHaveLength(1);

    // Research's request carries the whole conversation, not just the new message.
    const researchCall = upstream.requests.slice(before).find((r) => JSON.stringify(r.body).includes("## Conversation with Product manager"))!;
    const said = JSON.stringify((researchCall.body as { messages: unknown[] }).messages);
    expect(said).toContain("what drives churn for small customers?");
    expect(said).toContain("the last four quarters, counting downgrades");
    expect((await api<SessionView>(`/sessions/${id}`)).runs.map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("asks the user for the other agent's approvals in the session they are watching", async () => {
    const pm = await api<Session>("/sessions", "POST", { agent: "pm" });
    writeFileSync(path.join(pm.workspace, "hello.txt"), "churn notes");
    const run = await api<{ id: string }>(`/sessions/${pm.id}/runs`, "POST", { input: "ask research: read hello.txt" });
    const waiting = await settle(run.id);
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.pendingApprovals).toHaveLength(1);

    const view = await api<SessionView>(`/sessions/${pm.id}`);
    const asked = view.events.find((e) => e.type === "approval_requested") as Extract<RunEvent, { type: "approval_requested" }>;
    expect(asked).toMatchObject({ name: "file_read", input: { path: "hello.txt" }, via: { agent: "Research" } });
    expect(asked.callId).toBe(waiting.pendingApprovals[0]);
    expect(view.conversations.map((c) => c.id)).toEqual([asked.via!.conversation]);

    await api(`/runs/${run.id}/approvals/${asked.callId}`, "POST", { decision: "approve" });
    expect((await settle(run.id)).status).toBe("completed");
    const done = await api<SessionView>(`/sessions/${pm.id}`);
    expect(done.events.some((e) => e.type === "approval_resolved" && e.callId === asked.callId && e.decision === "approve")).toBe(true);
    expect(results(done).at(-1)!.output).toMatch(/The file says: 1\tchurn notes/);
  });

  it("refuses partners outside the list, loops back up the chain, and unknown conversations", async () => {
    const pm = await api<Session>("/sessions", "POST", { agent: "pm" });
    await say(pm.id, "ask analyst: anything");
    await say(pm.id, "ask pm: anything");
    await say(pm.id, "reply to sess_nothere: anything");
    const outs = results(await api<SessionView>(`/sessions/${pm.id}`)).map((r) => [r.isError, r.output]);
    expect(outs[0]).toEqual([true, "Product manager is not set up to talk to Analyst. You can talk to: research."]);
    expect(outs[1]).toEqual([true, "You cannot hold a conversation with yourself."]);
    expect(outs[2]).toEqual([true, 'There is no conversation "sess_nothere" started from here. Start one by naming the agent.']);

    // Research may talk to the PM, but not while the PM is waiting on Research.
    await say(pm.id, "ask research: ask pm: what should I prioritise?");
    const looped = results(await api<SessionView>(`/sessions/${pm.id}`)).at(-1)!;
    expect(looped.isError).toBe(false);
    const convo = await api<SessionView>(`/sessions/${conversationId(looped.output)!}`);
    expect(results(convo).at(-1)).toMatchObject({ isError: true, output: expect.stringMatching(/^Product manager is waiting for your reply in this chain of conversations/) });
  });

  it("keeps conversations read-only, and deletes them with the session that started them", async () => {
    const pm = await api<Session>("/sessions", "POST", { agent: "pm" });
    await say(pm.id, "ask research: hello");
    const id = (await api<SessionView>(`/sessions/${pm.id}`)).conversations[0].id;
    const typed = await call(`/sessions/${id}/runs`, "POST", { input: "hi research" });
    expect(typed.status).toBe(409);
    expect(((await typed.json()) as { error: string }).error).toMatch(/Talk to Product manager in the session it came from/);
    expect((await call(`/sessions/${id}/compact`, "POST")).status).toBe(409);

    await api(`/sessions/${pm.id}`, "DELETE");
    expect((await call(`/sessions/${id}`)).status).toBe(404);
  });

  it("warns about partners that cannot be reached", async () => {
    const v = await api<{ issues: { path: string; message: string }[] }>("/agents/validate", "POST", {
      name: "Lonely", slug: "lonely", model: { alias: "default" }, instructions: "x", tools: [], talksTo: ["lonely", "ghost"],
    });
    expect(v.issues.map((i) => i.message)).toEqual([
      "Agents to talk to are listed, but agent_message is not enabled, so the agent cannot reach them",
      "An agent cannot hold a conversation with itself",
      'agent "ghost" is not saved on this machine',
    ]);
  });
});
