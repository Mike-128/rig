import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connection, Model } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";

/**
 * Adding a provider together with the model it needs, and replacing a provider's key
 * without losing its models, aliases, or settings.
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

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "rig-connection-key-"));
  upstream = await startMockUpstream();
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });
});

afterAll(async () => {
  await rt?.close();
  await upstream?.close();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const named = { id: "mock-gpt", displayName: "Named model", dialect: "openai.chat", route: "/v1/chat/completions", query: { "api-version": "test" } };

describe("adding a provider with a named model", () => {
  it("stores the named model instead of the template's example routes", async () => {
    const res = await api<{ connection: Connection; models: Model[] }>("/connections", "POST", {
      name: "gateway-named", profileId: "apim-gateway", key: "synthetic", baseUrl: "https://gateway.example", models: [named],
    });
    expect(res.models.map((m) => m.providerModelId)).toEqual(["mock-gpt"]);
    expect(res.models[0]).toMatchObject({ origin: "manual", route: "/v1/chat/completions", query: { "api-version": "test" }, displayName: "Named model" });
    const stored = (await api<Model[]>("/models")).filter((m) => m.connectionId === res.connection.id);
    expect(stored.map((m) => m.providerModelId)).toEqual(["mock-gpt"]);
  });

  it("still seeds the template's examples when no model is named", async () => {
    const res = await api<{ models: Model[] }>("/connections", "POST", { name: "gateway-plain", profileId: "apim-gateway", key: "synthetic", baseUrl: "https://gateway.example" });
    expect(res.models.length).toBeGreaterThan(0);
    expect(res.models.every((m) => m.origin === "catalog")).toBe(true);
  });

  it("rejects an invalid named model without creating the connection", async () => {
    const res = await call("/connections", "POST", { name: "gateway-bad", profileId: "apim-gateway", key: "synthetic", models: [{ ...named, route: "  " }] });
    expect(res.status).toBe(400);
    expect((await api<Connection[]>("/connections")).some((c) => c.name === "gateway-bad")).toBe(false);
  });
});

describe("replacing a key", () => {
  it("keeps models and aliases, clears old results, and works with the new key", async () => {
    const { connection } = await api<{ connection: Connection }>("/connections", "POST", {
      name: "rotating", profileId: "openai-compatible", key: "old-key-1111", baseUrl: upstream.url,
      // The mock answers its exact route only, so this model carries no query string.
      extraHeaders: { "x-team": "synthetic" }, models: [{ ...named, query: undefined }],
    });
    const offset = upstream.requests.length;

    // discover=false tests the named model without asking for a listing.
    const before = await api<{ models: Model[]; listError?: string }>(`/connections/${connection.id}/probe?discover=false`, "POST");
    expect(before.listError).toBeUndefined();
    expect(before.models.find((m) => m.providerModelId === "mock-gpt")?.status).toBe("unauthorized");
    expect(upstream.requests.slice(offset).some((r) => r.path.startsWith("/v1/models"))).toBe(false);

    await api(`/aliases/rotating-alias`, "PUT", { connectionId: connection.id, modelId: "mock-gpt" });
    const updated = await api<Connection>(`/connections/${connection.id}/key`, "PUT", { key: GOOD_KEY });
    expect(updated).toMatchObject({ id: connection.id, name: "rotating", secretLast4: GOOD_KEY.slice(-4), extraHeaders: { "x-team": "synthetic" } });
    expect(await rt.app.secrets.get(connection.id)).toBe(GOOD_KEY);

    const models = (await api<Model[]>("/models")).filter((m) => m.connectionId === connection.id);
    expect(models.map((m) => [m.providerModelId, m.status, m.statusMessage])).toEqual([["mock-gpt", "unprobed", undefined]]);
    expect((await api<{ alias: string; modelId: string }[]>("/aliases")).find((a) => a.alias === "rotating-alias")?.modelId).toBe("mock-gpt");

    const after = await api<{ models: Model[] }>(`/connections/${connection.id}/probe?discover=false`, "POST");
    expect(after.models.find((m) => m.providerModelId === "mock-gpt")?.status).toBe("entitled");
    const sent = upstream.requests.at(-1)!;
    expect(sent.headers.authorization).toBe(`Bearer ${GOOD_KEY}`);
    expect(sent.headers["x-team"]).toBe("synthetic");
  });

  it("rejects an empty key and an unknown provider without changing the stored key", async () => {
    const { connection } = await api<{ connection: Connection }>("/connections", "POST", { name: "steady", profileId: "openai-compatible", key: "steady-key", baseUrl: upstream.url });
    for (const body of [{ key: "" }, { key: "   " }, {}]) expect((await call(`/connections/${connection.id}/key`, "PUT", body)).status).toBe(400);
    expect(await rt.app.secrets.get(connection.id)).toBe("steady-key");
    expect((await call(`/connections/missing/key`, "PUT", { key: "x" })).status).toBe(404);
  });
});
