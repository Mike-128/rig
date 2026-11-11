import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayProfile, Session } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";
import type { SetupStatus } from "../src/routes/settings";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";

/** Settings: the setup checklist from a fresh home to ready, preferences, and your instructions file. */

let home: string;
let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
let rt: RunningServer;

const call = async (p: string, init?: { method?: string; json?: unknown }) => {
  const res = await fetch(`http://127.0.0.1:${rt.port}/api${p}`, {
    method: init?.method ?? "GET",
    headers: init?.json !== undefined ? { "content-type": "application/json" } : {},
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "rig-settings-"));
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

describe("settings", () => {
  it("reports a fresh install as not ready, then ready once a default model is bound", async () => {
    const fresh = (await call("/setup")).body as SetupStatus;
    expect(fresh).toMatchObject({ connections: 0, defaultModel: null, ready: false, instructions: false, github: null, team: null });
    expect(fresh.agents).toBeGreaterThan(0);

    const conn = await call("/connections", { method: "POST", json: { name: "mock", profileId: "mock-gateway", key: GOOD_KEY } });
    await call(`/connections/${conn.body.connection.id}/probe`, { method: "POST" });
    await call("/aliases/default", { method: "PUT", json: { connectionId: conn.body.connection.id, modelId: "mock-claude" } });

    const after = (await call("/setup")).body as SetupStatus;
    expect(after).toMatchObject({ connections: 1, entitledModels: 1, defaultModel: { connection: "mock", model: "mock-claude", status: "entitled" }, ready: true });
  });

  it("stores defaults, rejects unknown agents, and starts new sessions in the default mode", async () => {
    expect((await call("/settings")).body).toEqual({});
    expect((await call("/settings", { method: "PUT", json: { projectAgent: "nobody" } })).status).toBe(400);
    expect((await call("/settings", { method: "PUT", json: { defaultMode: "sideways" } })).status).toBe(400);

    const saved = await call("/settings", { method: "PUT", json: { projectAgent: "coder", chatAgent: "assistant", defaultMode: "plan" } });
    expect(saved.body).toEqual({ projectAgent: "coder", chatAgent: "assistant", defaultMode: "plan" });
    expect(JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")).defaultMode).toBe("plan");

    const s = (await call("/sessions", { method: "POST", json: { agent: "assistant" } })).body as Session;
    expect(s.mode).toBe("plan");
    // An explicit mode still wins over the default.
    const t = (await call("/sessions", { method: "POST", json: { agent: "assistant", mode: "auto" } })).body as Session;
    expect(t.mode).toBe("auto");
  });

  it("edits ~/.rig/RIG.md, and clearing it removes the file", async () => {
    const file = path.join(home, "RIG.md");
    expect((await call("/instructions")).body).toMatchObject({ exists: false, text: "" });
    await call("/instructions", { method: "PUT", json: { text: "Prefer small commits." } });
    expect(readFileSync(file, "utf8")).toBe("Prefer small commits.\n");
    expect((await call("/setup")).body.instructions).toBe(true);
    await call("/instructions", { method: "PUT", json: { text: "  " } });
    expect(existsSync(file)).toBe(false);
  });
});
