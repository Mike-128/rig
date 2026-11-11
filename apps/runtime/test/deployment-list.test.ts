import { describe, expect, it } from "vitest";
import { deploymentList } from "../src/deployment-list";

const row = { id: "/subscriptions/example/deployments/chat-east", name: "chat-east", properties: { model: { format: "OpenAI", name: "model-family" }, capabilities: { chatCompletion: "true" }, provisioningState: "Succeeded" } };
describe("deployment inventory normalization", () => {
  it.each([ [row], { value: [row] }, { data: [row] } ])("uses deployment names, not resource IDs or model families: %j", (payload) => {
    expect(deploymentList(payload).data.map((m) => m.id)).toEqual(["chat-east"]);
  });
  it("accepts empty inventory and deduplicates deployments", () => {
    expect(deploymentList({ value: [] }).data).toEqual([]);
    expect(deploymentList([row, row]).data).toHaveLength(1);
  });
  it("excludes non-chat, unknown capabilities, failed and non-OpenAI deployments", () => {
    expect(deploymentList([
      { ...row, properties: { ...row.properties, capabilities: { chatCompletion: false } } },
      { ...row, properties: { ...row.properties, capabilities: undefined } },
      { ...row, properties: { ...row.properties, provisioningState: "Failed" } },
      { ...row, properties: { ...row.properties, model: { format: "Other", name: "other" } } },
      { ...row, properties: { ...row.properties, capabilities: { chatCompletion: true } } },
    ]).data).toHaveLength(1);
  });
  it("rejects unsupported shapes and incomplete pages without importing partial results", () => {
    for (const payload of [{ models: [row] }, { value: [{ id: "entitlement-only" }] }, { value: [row], nextLink: "https://example.invalid/next" }]) {
      expect(() => deploymentList(payload)).toThrow();
    }
  });
});
