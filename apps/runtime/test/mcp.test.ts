import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayProfile, RunEvent, Session } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";
import type { McpServerStatus } from "../src/mcp";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";

/** MCP servers as tool sources: configuration, connection, naming, gating, and calls. */

const here = path.dirname(fileURLToPath(import.meta.url));
let home: string;
let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
let rt: RunningServer;

const api = async <T>(p: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`http://127.0.0.1:${rt.port}/api${p}`, { ...init, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
  return data as T;
};

async function waitForRun(runId: string, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await api<{ status: string; pendingApprovals: string[] }>(`/runs/${runId}`);
    if (["completed", "failed", "cancelled", "awaiting_approval"].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error("run did not settle");
}

const echoServer = {
  command: process.execPath,
  args: ["--import", "tsx", path.join(here, "fixtures", "echo-mcp.ts")],
  cwd: path.resolve(here, ".."),
};

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "rig-mcp-"));
  upstream = await startMockUpstream();
  const profile: GatewayProfile = {
    id: "mock-gateway",
    displayName: "Mock gateway",
    baseUrl: upstream.url,
    auth: { headerName: "x-api-key" },
    models: [{ id: "mock-claude", dialect: "anthropic.messages", route: "/v1/messages" }],
  };
  mkdirSync(path.join(home, "profiles"), { recursive: true });
  writeFileSync(path.join(home, "profiles", "mock.json"), JSON.stringify(profile));
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });
  const conn = await api<{ connection: { id: string } }>("/connections", { method: "POST", json: { name: "mock", profileId: "mock-gateway", key: GOOD_KEY } });
  await api(`/aliases/default`, { method: "PUT", json: { connectionId: conn.connection.id, modelId: "mock-claude" } });
}, 30_000);

afterAll(async () => {
  await rt?.close();
  await upstream?.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows may still hold handles */
  }
});

describe("MCP", () => {
  it("rejects invalid configuration without touching the running servers", async () => {
    await expect(api("/mcp", { method: "PUT", json: { config: "{ not json" } })).rejects.toThrow(/Not valid JSON/);
    await expect(api("/mcp", { method: "PUT", json: { config: JSON.stringify({ mcpServers: { "bad name!": { command: "x" } } }) } })).rejects.toThrow(/400.*bad name/);
  });

  it("connects a stdio server and lists its tools under provider-safe names", async () => {
    const res = await api<{ servers: McpServerStatus[] }>("/mcp", {
      method: "PUT",
      json: { config: JSON.stringify({ mcpServers: { echo: echoServer, broken: { command: "rig-no-such-command-xyz" } } }, null, 2) },
    });
    const echo = res.servers.find((s) => s.name === "echo")!;
    expect(echo.status).toBe("connected");
    expect(echo.tools.map((t) => [t.fullName, t.readOnly]).sort()).toEqual([
      ["mcp__echo__echo", true],
      ["mcp__echo__save_note", false],
    ]);
    expect(res.servers.find((s) => s.name === "broken")?.status).toBe("failed");
  }, 30_000);

  it("runs a read-only MCP tool without asking, and gates one that changes things", async () => {
    await api("/agents/mcp-user", {
      method: "PUT",
      json: { name: "MCP user", slug: "mcp-user", model: { alias: "default" }, instructions: "Use your tools.", tools: ["mcp__*"] },
    });
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "mcp-user" } });

    const read = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "mcp echo" } });
    expect((await waitForRun(read.id)).status).toBe("completed");
    let evs = (await api<{ events: RunEvent[] }>(`/sessions/${session.id}`)).events;
    const result = evs.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result).toMatchObject({ name: "mcp__echo__echo", output: "echo: hi", isError: false });

    const write = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "mcp save" } });
    const waiting = await waitForRun(write.id);
    expect(waiting.status).toBe("awaiting_approval");
    await api(`/runs/${write.id}/approvals/${waiting.pendingApprovals[0]}`, { method: "POST", json: { decision: "approve" } });
    expect((await waitForRun(write.id)).status).toBe("completed");
    evs = (await api<{ events: RunEvent[] }>(`/sessions/${session.id}`)).events;
    expect(evs.filter((e) => e.type === "tool_result").at(-1)).toMatchObject({ name: "mcp__echo__save_note", output: "saved: hi" });
  }, 30_000);
});
