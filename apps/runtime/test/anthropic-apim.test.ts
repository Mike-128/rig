import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connection, Model, RunEvent, Session } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";

// Synthetic APIM contract: the backend's hosting platform is hidden from the client.
const route = "/ai/platform/claude/v1/messages";
const wireModel = "mock-claude-deployment";
let home: string;
let rt: RunningServer;
let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
let connection: Connection;

async function api<T>(route: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${rt.app.config.proxyOrigin}/api${route}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${route}: ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

async function settle(id: string) {
  for (let i = 0; i < 200; i++) {
    const run = await api<{ status: string; pendingApprovals: string[] }>(`/runs/${id}`);
    if (["completed", "failed", "cancelled", "awaiting_approval"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Run did not settle");
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "rig-anthropic-apim-"));
  upstream = await startMockUpstream({ anthropicGateway: { route: `${route}?revision=test`, model: wireModel } });
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });
  const created = await api<{ connection: Connection }>("/connections", "POST", {
    name: "synthetic-apim", profileId: "apim-gateway", baseUrl: upstream.url,
    key: GOOD_KEY, headerName: "Ocp-Apim-Subscription-Key",
    extraHeaders: { "X-Test-Project": "synthetic-project" },
  });
  connection = created.connection;
  await api(`/connections/${connection.id}/models`, "POST", {
    id: "local-claude", dialect: "anthropic.messages", route,
    bodyModel: wireModel, query: { revision: "test" },
  });
  await api("/agents/apim-reader", "PUT", {
    name: "APIM reader", slug: "apim-reader",
    model: { connection: connection.name, model: "local-claude" },
    instructions: "Read the requested file with file_read.",
    tools: ["file_read"], approvals: ["file_read"], sandbox: 1,
  });
});

afterAll(async () => {
  await rt?.close();
  await upstream?.close();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Anthropic Messages through APIM", () => {
  it.each(["approve", "deny"] as const)("streams a tool call and returns the %s result through the gateway", async (decision) => {
    const offset = upstream.requests.length;
    const session = await api<Session>("/sessions", "POST", { agent: "apim-reader" });
    writeFileSync(path.join(session.workspace, "hello.txt"), "synthetic file content");
    const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, "POST", { input: "read hello.txt" });
    const waiting = await settle(run.id);
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.pendingApprovals).toHaveLength(1);
    await api(`/runs/${run.id}/approvals/${waiting.pendingApprovals[0]}`, "POST", { decision });
    expect((await settle(run.id)).status).toBe("completed");

    const calls = upstream.requests.slice(offset);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.path).toBe(`${route}?revision=test`);
      expect(call.headers["ocp-apim-subscription-key"]).toBe(GOOD_KEY);
      expect(call.headers["x-test-project"]).toBe("synthetic-project");
      expect(call.headers["anthropic-version"]).toBe("2023-06-01");
      for (const header of ["x-api-key", "authorization", "x-rig-proxy-token"]) expect(call.headers[header]).toBeUndefined();
      expect(call.body).toMatchObject({ model: wireModel, stream: true, max_tokens: 16000 });
      expect(call.body).not.toHaveProperty("anthropic_version");
    }
    expect(calls[0].body).toMatchObject({ tools: [expect.objectContaining({ name: "file_read", input_schema: expect.objectContaining({ type: "object" }) })] });
    const expected = decision === "approve" ? "synthetic file content" : "The user declined this tool call.";
    expect(calls[1].body).toMatchObject({ messages: [
      { role: "user", content: [{ type: "text", text: "read hello.txt" }] },
      { role: "assistant", content: [expect.anything(), { type: "tool_use", id: "toolu_1", name: "file_read", input: { path: "hello.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: expected, is_error: decision === "deny" }] },
    ] });
    const detail = await api<{ events: RunEvent[] }>(`/sessions/${session.id}`);
    expect(detail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_result", output: expected, isError: decision === "deny" }),
      expect.objectContaining({ type: "run_completed", turns: 2 }),
    ]));
    const replies = detail.events.filter((e) => e.type === "assistant_message");
    expect(replies.at(-1)).toMatchObject({ message: { content: [{ type: "text", text: `The file says: ${expected}` }] } });
  });

  it("does not mistake a validation-only probe for successful inference", async () => {
    await api(`/connections/${connection.id}/headers`, "PATCH", {});
    try {
      const probe = await api<Model>(`/models/${connection.id}/local-claude/probe`, "POST");
      // Preserve the established probe classification; inference must still fail visibly.
      expect(probe.status).toBe("entitled");
      const session = await api<Session>("/sessions", "POST", { agent: "apim-reader" });
      const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, "POST", { input: "read hello.txt" });
      expect((await settle(run.id)).status).toBe("failed");
      const detail = await api<{ events: RunEvent[] }>(`/sessions/${session.id}`);
      expect(detail.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "run_failed", error: expect.objectContaining({ kind: "invalid_request", status: 400 }) }),
      ]));
      expect(detail.events.some((e) => e.type === "tool_call" || e.type === "run_completed")).toBe(false);
    } finally {
      await api(`/connections/${connection.id}/headers`, "PATCH", { "x-test-project": "synthetic-project" });
    }
  });
});
