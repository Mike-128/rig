import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayProfile, Model, RunEvent, Session } from "@harness/core";
import { startServer, type RunningServer } from "../src/server";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";

/**
 * Definition of done, end to end, against a mock upstream that speaks both dialects:
 * probe a model -> create and save an agent -> run it (tool call + approval) -> replay after restart.
 */

let home: string;
let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
let rt: RunningServer;

const api = async <T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`http://127.0.0.1:${rt.port}/api${path}`, { ...init, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data)}`);
  return data as T;
};

async function waitForRun(runId: string, timeoutMs = 10_000): Promise<{ status: string; pendingApprovals: string[] }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await api<{ status: string; pendingApprovals: string[] }>(`/runs/${runId}`);
    if (["completed", "failed", "cancelled", "awaiting_approval"].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("run did not settle");
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  upstream = await startMockUpstream();
  const profile: GatewayProfile = {
    id: "mock-gateway",
    displayName: "Mock gateway",
    baseUrl: upstream.url,
    auth: { headerName: "x-api-key" },
    models: [
      { id: "mock-claude", dialect: "anthropic.messages", route: "/v1/messages", pricing: { input: 1, output: 2 } },
      { id: "mock-gpt", dialect: "openai.chat", route: "/v1/chat/completions", pricing: { input: 1, output: 2 } },
      { id: "mock-missing", dialect: "openai.chat", route: "/v1/chat/completions" },
    ],
    listModels: { dialect: "openai.chat", route: "/v1/models", filter: "^mock-", defaultRoute: "/v1/chat/completions" },
  };
  mkdirSync(path.join(home, "profiles"), { recursive: true });
  writeFileSync(path.join(home, "profiles", "mock.json"), JSON.stringify(profile));
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });
}, 30_000);

afterAll(async () => {
  await rt?.close();
  await upstream?.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows can hold SQLite handles briefly; leaving a temp dir behind is harmless */
  }
});

describe("v1 definition of done", () => {
  let connId: string;
  let sessionId: string;
  let firstEventCount = 0;

  it("1. probes a model: entitled, not found, and unauthorized are told apart", async () => {
    const created = await api<{ connection: { id: string }; models: Model[] }>("/connections", {
      method: "POST",
      json: { name: "mock", profileId: "mock-gateway", key: GOOD_KEY },
    });
    connId = created.connection.id;
    expect(created.models).toHaveLength(3);

    const probed = await api<{ models: Model[]; listed: number; boundDefault?: { modelId: string } }>(`/connections/${connId}/probe`, { method: "POST" });
    // With no alias set, probing binds "default" to an entitled chat model so seeded agents work immediately.
    expect(probed.boundDefault?.modelId).toBe("mock-claude");
    expect((await api<{ alias: string }[]>("/aliases")).map((a) => a.alias)).toEqual(["default"]);
    const byId = Object.fromEntries(probed.models.map((m) => [m.providerModelId, m]));
    expect(byId["mock-claude"].status).toBe("entitled");
    expect(byId["mock-gpt"].status).toBe("entitled");
    expect(byId["mock-missing"].status).toBe("not_found");
    // listing discovered one extra model behind the filter and skipped the embedding model
    expect(probed.listed).toBe(1);
    expect(byId["mock-gpt-extra"].status).toBe("listed");
    expect(byId["embed-x"]).toBeUndefined();

    // the upstream saw the real key, never the proxy token
    const last = upstream.requests.at(-1)!;
    expect(last.headers["x-api-key"]).toBe(GOOD_KEY);
    expect(last.headers["x-harness-proxy-token"]).toBeUndefined();

    // an existing binding is never overwritten by a later probe
    await api("/aliases/default", { method: "PUT", json: { connectionId: connId, modelId: "mock-gpt" } });
    const reprobe = await api<{ boundDefault?: unknown }>(`/connections/${connId}/probe`, { method: "POST" });
    expect(reprobe.boundDefault).toBeUndefined();
    expect((await api<{ alias: string; modelId: string }[]>("/aliases"))[0].modelId).toBe("mock-gpt");

    // a wrong key classifies as unauthorized
    const bad = await api<{ connection: { id: string } }>("/connections", { method: "POST", json: { name: "bad", profileId: "mock-gateway", key: "nope" } });
    const badProbe = await api<{ models: Model[] }>(`/connections/${bad.connection.id}/probe`, { method: "POST" });
    expect(badProbe.models.find((m) => m.providerModelId === "mock-gpt")?.status).toBe("unauthorized");
    await api(`/connections/${bad.connection.id}`, { method: "DELETE" });
  });

  it("2 & 3. creates, validates, and saves an agent with versioning and YAML export", async () => {
    const def = {
      name: "Reader",
      slug: "reader",
      model: { connection: "mock", model: "mock-gpt" },
      instructions: "Read files when asked.",
      tools: ["file_read", "file_write"],
      approvals: ["file_write"],
      sandbox: 1,
    };
    const bad = await api<{ ok: boolean; issues: { message: string }[] }>("/agents/validate", { method: "POST", json: { ...def, approvals: ["shell"] } });
    expect(bad.ok).toBe(false);

    const saved = await api<{ ok: boolean; saved: { version: number } }>("/agents/reader", { method: "PUT", json: def });
    expect(saved.ok).toBe(true);
    expect(saved.saved.version).toBe(1);

    // unchanged save keeps the version; a change bumps it and archives the old file
    const again = await api<{ saved: { version: number } }>("/agents/reader", { method: "PUT", json: def });
    expect(again.saved.version).toBe(1);
    const bumped = await api<{ saved: { version: number } }>("/agents/reader", { method: "PUT", json: { ...def, description: "v2" } });
    expect(bumped.saved.version).toBe(2);
    expect(existsSync(path.join(home, "agents", "reader.yaml"))).toBe(true);
    expect(existsSync(path.join(home, "agents", "history", "reader", "v1.yaml"))).toBe(true);

    const yaml = await fetch(`http://127.0.0.1:${rt.port}/api/agents/reader/export`).then((r) => r.text());
    expect(yaml).toMatch(/slug: reader/);
    expect(yaml).toMatch(/version: 2/);

    // import round-trips through YAML
    const imported = await api<{ ok: boolean; saved: { slug: string } }>("/agents/import", { method: "POST", body: yaml.replace("slug: reader", "slug: reader-copy"), headers: { "content-type": "application/yaml" } });
    expect(imported.ok).toBe(true);
    expect(imported.saved.slug).toBe("reader-copy");
    const list = await api<{ slug: string }[]>("/agents");
    expect(list.map((a) => a.slug).sort()).toEqual(["agent-builder", "assistant", "reader", "reader-copy"]);
  });

  it("4. runs the agent on the OpenAI dialect: streams, calls a tool, records usage and cost", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "reader" } });
    sessionId = session.id;
    writeFileSync(path.join(session.workspace, "hello.txt"), "hello from the workspace");

    const run = await api<{ id: string }>(`/sessions/${sessionId}/runs`, { method: "POST", json: { input: "Please read hello.txt" } });
    const settled = await waitForRun(run.id);
    expect(settled.status).toBe("completed");

    const detail = await api<{ events: RunEvent[]; messages: { role: string }[] }>(`/sessions/${sessionId}`);
    const types = detail.events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    const result = detail.events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.output).toBe("hello from the workspace");
    const done = detail.events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    expect(done.turns).toBe(2);
    expect(done.usage.inputTokens).toBe(22);
    expect(done.costUsd).toBeCloseTo((22 * 1 + 16 * 2) / 1_000_000, 10);
    const final = detail.events.filter((e) => e.type === "assistant_message").at(-1) as Extract<RunEvent, { type: "assistant_message" }>;
    expect(final.message.content[0]).toEqual({ type: "text", text: "The file says: hello from the workspace" });
    // no transient deltas were persisted
    expect(types).not.toContain("text_delta");

    // Provider metadata on a tool call is replayed verbatim on the next request.
    // Gemini 3 rejects the follow-up turn with a 400 when its thought_signature is dropped.
    const followUp = upstream.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!;
    const replayed = (followUp.body as { messages: { role: string; tool_calls?: { extra_content?: unknown }[] }[] }).messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(replayed?.tool_calls?.[0].extra_content).toEqual({ google: { thought_signature: "sig-abc" } });
    firstEventCount = detail.events.length;
  });

  it("4b. gates an approval-required tool and resumes on approve", async () => {
    // second turn on the same session: the mock does not call file_write, so drive approval through a dedicated agent
    await api("/agents/writer", {
      method: "PUT",
      json: { name: "Writer", slug: "writer", model: { connection: "mock", model: "mock-claude" }, instructions: "x", tools: ["file_read"], approvals: ["file_read"], sandbox: 1 },
    });
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "writer" } });
    writeFileSync(path.join(session.workspace, "hello.txt"), "gated");
    const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "read it" } });
    const waiting = await waitForRun(run.id);
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.pendingApprovals).toHaveLength(1);
    await api(`/runs/${run.id}/approvals/${waiting.pendingApprovals[0]}`, { method: "POST", json: { decision: "approve" } });
    const done = await waitForRun(run.id);
    expect(done.status).toBe("completed");
    const detail = await api<{ events: RunEvent[] }>(`/sessions/${session.id}`);
    expect(detail.events.map((e) => e.type)).toEqual(expect.arrayContaining(["approval_requested", "approval_resolved", "tool_result"]));
    const final = detail.events.filter((e) => e.type === "assistant_message").at(-1) as Extract<RunEvent, { type: "assistant_message" }>;
    expect(final.message.content.some((b) => b.type === "text" && b.text === "The file says: gated")).toBe(true);
    // the Anthropic-dialect request carried the standard header set through the proxy
    const call = upstream.requests.filter((r) => r.path === "/v1/messages").at(-1)!;
    expect(call.headers["x-api-key"]).toBe(GOOD_KEY);
    expect(call.headers["anthropic-version"]).toBeDefined();
  });

  it("4c. a denied approval is reported to the model as an error result", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "writer" } });
    const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "read it" } });
    const waiting = await waitForRun(run.id);
    await api(`/runs/${run.id}/approvals/${waiting.pendingApprovals[0]}`, { method: "POST", json: { decision: "deny" } });
    await waitForRun(run.id);
    const detail = await api<{ events: RunEvent[] }>(`/sessions/${session.id}`);
    const result = detail.events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/declined/);
  });

  it("5. replays a session from the event log after a runtime restart, and continues it", async () => {
    await rt.close();
    rt = await startServer({ home, port: 0 }, { fileSecrets: true });
    const detail = await api<{ events: RunEvent[]; messages: { role: string }[]; session: Session }>(`/sessions/${sessionId}`);
    expect(detail.events).toHaveLength(firstEventCount);
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    // history is carried into the next turn: the upstream receives the earlier tool exchange
    const run = await api<{ id: string }>(`/sessions/${sessionId}/runs`, { method: "POST", json: { input: "thanks" } });
    expect((await waitForRun(run.id)).status).toBe("completed");
    const last = upstream.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)!;
    const msgs = (last.body as { messages: { role: string }[] }).messages;
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);

    // keys survived the restart via the secret store
    const probe = await api<{ models: Model[] }>(`/connections/${connId}/probe`, { method: "POST" });
    expect(probe.models.find((m) => m.providerModelId === "mock-gpt")?.status).toBe("entitled");
    expect(readFileSync(path.join(home, "agents", "reader.yaml"), "utf8")).toMatch(/name: Reader/);
  });

  it("rejects proxy calls without the loopback token", async () => {
    const res = await fetch(`http://127.0.0.1:${rt.port}/proxy/${connId}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-gpt", messages: [] }),
    });
    expect(res.status).toBe(401);
  });
});
