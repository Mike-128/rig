import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection, Model } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";

/**
 * What a model test reports: the provider's HTTP status, a request the gateway rejected for a
 * missing header, and a successful answer in the wrong dialect's format.
 */
let home: string;
let rt: RunningServer;
let gateway: http.Server;
let gatewayUrl: string;

async function api<T>(route: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${rt.app.config.proxyOrigin}/api${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${route}: ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

beforeAll(async () => {
  // A gateway that requires a charge-code header on chat completions, and serves Messages-format answers on /v1/messages.
  gateway = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on("end", () => {
      if (req.url?.startsWith("/v1/chat/completions")) {
        if (!req.headers["x-charge-code"]) return send(400, { error: { message: "Missing required header x-charge-code", type: "invalid_request_error" } });
        return send(200, { id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      }
      if (req.url?.startsWith("/v1/messages")) return send(200, { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
      send(404, { error: { message: "no route" } });
    });
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  home = mkdtempSync(path.join(os.tmpdir(), "rig-probe-results-"));
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });
});

afterAll(async () => {
  await rt?.close();
  await new Promise((r) => gateway?.close(r));
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("model tests", () => {
  let conn: Connection;
  const byId = (models: Model[], id: string) => models.find((m) => m.providerModelId === id)!;

  it("records the HTTP status, and a missing header shows as a rejected request with the gateway's message", async () => {
    const created = await api<{ connection: Connection }>("/connections", "POST", {
      name: "charge-gateway",
      profileId: "openai-compatible",
      key: "synthetic",
      baseUrl: gatewayUrl,
      kind: "gateway",
      models: [
        { id: "chat-model", dialect: "openai.chat", route: "/v1/chat/completions" },
        { id: "wrong-dialect", dialect: "openai.chat", route: "/v1/messages" },
      ],
    });
    conn = created.connection;
    const { models } = await api<{ models: Model[] }>(`/connections/${conn.id}/probe?discover=false`, "POST");
    // Still usable for routing (the key reached the model), but the code and message are kept.
    expect(byId(models, "chat-model")).toMatchObject({ status: "entitled", statusCode: 400 });
    expect(byId(models, "chat-model").statusMessage).toMatch(/x-charge-code/);
  });

  it("flags a successful answer in the other dialect's format instead of calling it reachable", async () => {
    const models = (await api<Model[]>("/models")).filter((m) => m.connectionId === conn.id);
    expect(byId(models, "wrong-dialect")).toMatchObject({ status: "unknown", statusCode: 200 });
    expect(byId(models, "wrong-dialect").statusMessage).toMatch(/dialect/);
  });

  it("reports a gateway that cannot be reached as no answer with its cause, not as a gateway 502", async () => {
    // A port that was free a moment ago, so nothing is listening on it.
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as { port: number }).port;
    await new Promise((r) => closed.close(r));
    const { connection } = await api<{ connection: Connection }>("/connections", "POST", {
      name: "nothing-listening", profileId: "openai-compatible", key: "synthetic", baseUrl: `http://127.0.0.1:${port}`, kind: "gateway",
      models: [{ id: "any-model", dialect: "openai.chat", route: "/v1/chat/completions" }],
    });
    const { models } = await api<{ models: Model[] }>(`/connections/${connection.id}/probe?discover=false`, "POST");
    expect(models[0].status).toBe("unknown");
    expect(models[0].statusCode).toBeUndefined();
    expect(models[0].statusMessage).toMatch(new RegExp(`^Could not connect to 127\\.0\\.0\\.1:${port}: .*ECONNREFUSED`));
  });

  it("answers 200 once the header is added, and clears the code when settings change", async () => {
    await api(`/connections/${conn.id}`, "PATCH", { extraHeaders: { "x-charge-code": "cc-123" } });
    const reset = (await api<Model[]>("/models")).filter((m) => m.connectionId === conn.id);
    expect(reset.every((m) => m.status === "unprobed" && m.statusCode === undefined)).toBe(true);
    const { models } = await api<{ models: Model[] }>(`/connections/${conn.id}/probe?discover=false`, "POST");
    expect(byId(models, "chat-model")).toMatchObject({ status: "entitled", statusCode: 200 });
    expect(byId(models, "chat-model").statusMessage).toMatch(/^\d+ ms$/);
  });
});
