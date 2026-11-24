import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connection, Model, Run, Session } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";

/**
 * A firewall in front of a gateway answers with its own web page, not an API error. Chat and
 * model tests should say what happened in one readable line and keep the reference id.
 */
const REF = "20260101T120000Z-r0000000000example00000000000000000000";
const PAGE = `<!DOCTYPE html><html><head><style type='text/css'>body { font-family: Arial; }</style><title>Service unavailable</title></head><body><div id='message'><h2>The request is blocked.</h2></div><div id='errorref'><span>${REF}</span></div></body></html>`;

let home: string;
let rt: RunningServer;
let firewall: http.Server;
let firewallUrl: string;

async function api<T>(route: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${rt.app.config.proxyOrigin}/api${route}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${route}: ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "rig-firewall-"));
  firewall = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(403, { "content-type": "text/html", "x-azure-ref": REF });
      res.end(PAGE);
    });
  });
  await new Promise<void>((resolve) => firewall.listen(0, "127.0.0.1", resolve));
  firewallUrl = `http://127.0.0.1:${(firewall.address() as AddressInfo).port}`;
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });
});

afterAll(async () => {
  await rt?.close();
  await new Promise((resolve) => firewall?.close(resolve));
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a firewall block page", () => {
  it("reads as one line with the reference, in a model test and in a chat", async () => {
    const { connection } = await api<{ connection: Connection }>("/connections", "POST", {
      name: "walled", profileId: "apim-gateway", baseUrl: firewallUrl, key: "synthetic", headerName: "Ocp-Apim-Subscription-Key",
      models: [{ id: "walled-claude", dialect: "anthropic.messages", route: "/claude/v1/messages" }],
    });
    const probed = await api<{ models: Model[] }>(`/connections/${connection.id}/probe?discover=false`, "POST");
    const model = probed.models.find((m) => m.providerModelId === "walled-claude")!;
    expect(model).toMatchObject({ status: "forbidden", statusCode: 403 });
    expect(model.statusMessage).toMatch(/^A firewall in front of the provider blocked this request \(403\); it did not reach the model\. Its page says: "The request is blocked\." Reference: 20260101T120000Z-r0000000000example00000000000000000000\./);
    expect(model.statusMessage).not.toMatch(/<|font-family/);

    await api("/aliases/default", "PUT", { connectionId: connection.id, modelId: "walled-claude" });
    const session = await api<Session>("/sessions", "POST", { agent: "assistant" });
    const started = await api<{ id: string }>(`/sessions/${session.id}/runs`, "POST", { input: "Testing" });
    let run: Run | undefined;
    for (let i = 0; i < 200; i++) {
      run = await api<Run>(`/runs/${started.id}`);
      if (["completed", "failed", "cancelled"].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain('blocked this request (403); it did not reach the model. Its page says: "The request is blocked."');
    expect(run?.error).toContain(`Reference: ${REF}.`);
    expect(run?.error).not.toMatch(/<|font-family/);
  });
});
