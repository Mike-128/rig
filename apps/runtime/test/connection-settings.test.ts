import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/server";
import type { Connection, Model } from "@rig/core";

const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const upstream = createServer(async (req, res) => {
  seen.push({ url: req.url!, headers: req.headers });
  for await (const _ of req) { /* drain request */ }
  res.setHeader("content-type", "application/json");
  if (req.headers["x-company-charge-code"] !== "charge-123") {
    res.writeHead(400); res.end(JSON.stringify({ error: { message: "required charge code missing" } })); return;
  }
  if (req.url?.startsWith("/inventory")) {
    res.end(JSON.stringify({ object: "list", data: ["allowed", "denied"].map((id) => ({ id, object: "model", created: 0, owned_by: "test" })) })); return;
  }
  if (req.url === "/bad-deployments") { res.end(JSON.stringify({ unsupported: [] })); return; }
  if (req.url === "/forbidden-list") { res.writeHead(403); res.end(JSON.stringify({ error: { message: "inventory denied" } })); return; }
  if (req.url?.startsWith("/deployments")) {
    res.end(JSON.stringify({ value: [{ id: "/resource/not-the-model-id", name: "azure-chat", properties: { model: { format: "OpenAI", name: "family" }, capabilities: { chatCompletion: "true" } } }] })); return;
  }
  if (req.url?.includes("denied")) { res.writeHead(403); res.end(JSON.stringify({ error: { message: "not permitted" } })); return; }
  res.end(JSON.stringify({ id: "test", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
let rt: RunningServer;
let home: string;
let conn: Connection;
const api = (route: string, method = "GET", body?: unknown) => fetch(`${rt.app.config.proxyOrigin}/api${route}`, {
  method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  home = mkdtempSync(path.join(os.tmpdir(), "rig-headers-"));
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });
  const response = await api("/connections", "POST", { name: "test", profileId: "apim-gateway", key: "test-secret", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, extraHeaders: { "X-Company-Charge-Code": "charge-123" } });
  expect(response.status).toBe(201);
  conn = (await response.json() as { connection: Connection }).connection;
});
afterAll(async () => {
  await rt?.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("connection headers and inventory", () => {
  it("injects saved headers into probes and protects them from client overrides", async () => {
    await api(`/connections/${conn.id}/models`, "POST", { id: "manual", dialect: "openai.chat", route: "/invoke/allowed" });
    const response = await api(`/models/${conn.id}/manual/probe`, "POST");
    expect((await response.json() as Model).status).toBe("entitled");
    expect(seen.at(-1)?.headers["ocp-apim-subscription-key"]).toBe("test-secret");
    expect(seen.at(-1)?.headers["x-company-charge-code"]).toBe("charge-123");
    expect(seen.at(-1)?.headers["x-rig-proxy-token"]).toBeUndefined();
    await fetch(`${rt.app.config.proxyOrigin}/proxy/${conn.id}/openai/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", "x-rig-proxy-token": rt.app.config.proxyToken, "X-Company-Charge-Code": "spoof" },
      body: JSON.stringify({ model: "manual", messages: [] }),
    });
    expect(seen.at(-1)?.headers["x-company-charge-code"]).toBe("charge-123");
  });
  it("lists using the same key and headers, expands routes, and probes the inventory", async () => {
    const spec = { dialect: "openai.chat", route: "/inventory?api-version=list-v1", defaultRoute: "/invoke/{model}?api-version=call-v1" };
    expect((await api(`/connections/${conn.id}/discovery`, "PUT", spec)).status).toBe(200);
    const response = await api(`/connections/${conn.id}/probe?includeListed=true`, "POST");
    const result = await response.json() as { models: Model[]; listed: number; listError?: string };
    expect(result.listError).toBeUndefined();
    expect(result.listed).toBe(2);
    expect(result.models.find((m) => m.providerModelId === "allowed")).toMatchObject({ origin: "listed", status: "entitled", route: "/invoke/allowed?api-version=call-v1" });
    expect(result.models.find((m) => m.providerModelId === "denied")?.status).toBe("forbidden");
    expect(seen.some((r) => r.url === "/inventory?api-version=list-v1" && r.headers["x-company-charge-code"] === "charge-123")).toBe(true);
    await fetch(`${rt.app.config.proxyOrigin}/proxy/${conn.id}/openai/v1/models?after=first&limit=2`, { headers: { "x-rig-proxy-token": rt.app.config.proxyToken } });
    expect(seen.at(-1)?.url).toBe("/inventory?api-version=list-v1&after=first&limit=2");
  });
  it("persists settings across restart and clears stale probe state on header changes", async () => {
    await rt.close();
    rt = await startServer({ home, port: 0 }, { fileSecrets: true });
    expect(rt.app.connections.get(conn.id)?.extraHeaders).toEqual({ "x-company-charge-code": "charge-123" });
    expect(rt.app.connections.discovery(conn.id)?.route).toBe("/inventory?api-version=list-v1");
    expect((await api(`/connections/${conn.id}/headers`, "PATCH", {})).status).toBe(200);
    expect(rt.app.models.list(conn.id).every((m) => m.status === "unprobed" && !m.lastProbedAt)).toBe(true);
    expect(await rt.app.secrets.get(conn.id)).toBe("test-secret");
    await api(`/connections/${conn.id}/headers`, "PATCH", { "x-company-charge-code": "charge-123" });
  });
  it("normalizes deployment inventory through the authenticated proxy and preserves saved models", async () => {
    const spec = { dialect: "openai.chat", responseFormat: "azure-deployments", route: "/deployments", defaultRoute: "/invoke/{model}?api-version=test-version", defaultParams: { maxTokensField: "max_completion_tokens" } };
    expect((await api(`/connections/${conn.id}/discovery`, "PUT", spec)).status).toBe(200);
    const response = await api(`/connections/${conn.id}/probe?includeListed=true`, "POST");
    const result = await response.json() as { models: Model[]; listed: number; listError?: string };
    expect(result.listError).toBeUndefined();
    expect(result.listed).toBe(1);
    expect(result.models.find((m) => m.providerModelId === "azure-chat")).toMatchObject({ route: "/invoke/azure-chat?api-version=test-version", status: "entitled" });
    expect(result.models.find((m) => m.providerModelId === "manual")?.route).toBe("/invoke/allowed");
    expect(seen.find((r) => r.url === "/deployments")?.headers["ocp-apim-subscription-key"]).toBe("test-secret");
    expect(rt.app.connections.discovery(conn.id)?.responseFormat).toBe("azure-deployments");
    expect(result.models.find((m) => m.providerModelId === "azure-chat")?.params?.maxTokensField).toBe("max_completion_tokens");
    const repeated = await (await api(`/connections/${conn.id}/probe?includeListed=true`, "POST")).json() as { listed: number };
    expect(repeated.listed).toBe(0);
  });
  it("rejects malformed headers and authentication overrides without changing saved headers", async () => {
    for (const headers of [{ Host: "other" }, { "bad name": "value" }, { "x-code": "bad\r\nvalue" }, { "X-Code": "a", "x-code": "b" }, { "Ocp-Apim-Subscription-Key": "replace" }]) {
      expect((await api(`/connections/${conn.id}/headers`, "PATCH", headers)).status).toBe(400);
    }
    expect(rt.app.connections.get(conn.id)?.extraHeaders).toEqual({ "x-company-charge-code": "charge-123" });
    expect((await api(`/connections/${conn.id}/discovery`, "PUT", { dialect: "openai.chat", route: "https://other", defaultRoute: "/call" })).status).toBe(400);
    expect((await api("/connections/missing/headers", "PATCH", {})).status).toBe(404);
  });
  it("reports invalid deployment responses and upstream permission errors", async () => {
    for (const [route, message] of [["/bad-deployments", "Expected a deployment array"], ["/forbidden-list", "inventory denied"]]) {
      await api(`/connections/${conn.id}/discovery`, "PUT", { dialect: "openai.chat", responseFormat: "azure-deployments", route, defaultRoute: "/invoke/{model}" });
      const result = await (await api(`/connections/${conn.id}/probe`, "POST")).json() as { listed: number; listError: string };
      expect(result.listed).toBe(0);
      expect(result.listError).toContain(message);
    }
  });
  it("reports absent discovery honestly and keeps 400 validation errors classified as entitled", async () => {
    await api(`/connections/${conn.id}/discovery`, "PUT", null);
    await api(`/connections/${conn.id}/headers`, "PATCH", {});
    const response = await api(`/connections/${conn.id}/probe`, "POST");
    const result = await response.json() as { listError: string; models: Model[] };
    expect(result.listError).toContain("not a complete inventory");
    expect(result.models.find((m) => m.providerModelId === "manual")).toMatchObject({ status: "entitled", statusMessage: expect.stringContaining("charge code missing") });
  });
});
