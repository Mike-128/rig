import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUpstream, type Model } from "@rig/core";
import { buildApp, type BuiltApp } from "../src/app";

let built: BuiltApp;
let home: string;
let connectionId: string;
const request = (route: string, method: string, body: unknown) => built.hono.request(`/api${route}`, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const endpoint = () => `/models/${connectionId}/${encodeURIComponent("manual/model")}`;

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "rig-model-edit-"));
  built = await buildApp({ home }, { fileSecrets: true });
  const res = await request("/connections", "POST", { name: "test", profileId: "apim-gateway", key: "test-only", baseUrl: "https://gateway.example" });
  connectionId = (await res.json() as { connection: { id: string } }).connection.id;
  const created = await request(`/connections/${connectionId}/models`, "POST", {
    id: "manual/model", dialect: "openai.chat", route: "/old", query: { "api-version": "old" },
    bodyModel: "old-body", pricing: { input: 1, output: 2 },
  });
  expect(created.status).toBe(201);
});
afterEach(() => {
  built?.app.db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("manual model editing", () => {
  it("updates routing in place, preserves aliases/pricing, and clears stale entitlement", async () => {
    const original = built.app.models.find(connectionId, "manual/model")!;
    built.app.models.setAlias({ alias: "default", connectionId, modelId: original.providerModelId });
    built.app.models.setStatus(original.id, "entitled", "old result", new Date().toISOString());
    const res = await request(endpoint(), "PATCH", {
      route: "/deployments/new/chat/completions?api-version=inline", query: { "api-version": "new" },
      displayName: "Updated", bodyModel: "new-body", reasoning: true, maxTokensField: "max_completion_tokens",
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as Model;
    expect(updated).toMatchObject({ id: original.id, providerModelId: original.providerModelId, displayName: "Updated", status: "unprobed", pricing: original.pricing });
    expect(updated.lastProbedAt).toBeUndefined();
    expect(updated.statusMessage).toBeUndefined();
    expect(built.app.models.getAlias("default")?.modelId).toBe("manual/model");
    expect(built.app.models.find(connectionId, "manual/model")?.bodyModel).toBe("new-body");
    const target = resolveUpstream(built.app.connections.get(connectionId)!, updated, "test-only");
    expect(target.url).toBe("https://gateway.example/deployments/new/chat/completions?api-version=new");
    expect(target.bodyModel).toBe("new-body");
  });

  it("supports clearing overrides while preserving fields omitted from a patch", async () => {
    const res = await request(endpoint(), "PATCH", { bodyModel: "", displayName: "", query: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bodyModel: "manual/model", displayName: "manual/model", query: {}, route: "/old" });
  });

  it("rejects invalid values and identity changes without changing the stored model", async () => {
    const original = built.app.models.find(connectionId, "manual/model");
    for (const body of [{ route: "   " }, { dialect: "unsupported" }, { query: { version: 1 } }, { id: "renamed" }]) {
      expect((await request(endpoint(), "PATCH", body)).status).toBe(400);
    }
    expect(built.app.models.find(connectionId, "manual/model")).toEqual(original);
  });

  it("rejects edits of catalog models and missing models", async () => {
    expect((await request(`/models/${connectionId}/gpt-5`, "PATCH", { route: "/new" })).status).toBe(409);
    expect((await request(`/models/${connectionId}/missing`, "PATCH", { route: "/new" })).status).toBe(404);
  });
});
