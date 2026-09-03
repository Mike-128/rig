import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  agentFromYaml,
  agentToYaml,
  classifyProbeError,
  estimateCost,
  policyForAgent,
  projectMessages,
  proxyBaseUrl,
  resolveInWorkspace,
  resolveUpstream,
  toolsFor,
  validateAgentDefinition,
  type Connection,
  type Model,
  type RunEvent,
} from "../src";

describe("probe classification", () => {
  it("treats validation errors as entitled and auth failures as not", () => {
    expect(classifyProbeError({ kind: "invalid_request", message: "", retryable: false })).toBe("entitled");
    expect(classifyProbeError({ kind: "auth", message: "", retryable: false })).toBe("unauthorized");
    expect(classifyProbeError({ kind: "forbidden", message: "", retryable: false })).toBe("forbidden");
    expect(classifyProbeError({ kind: "not_found", message: "", retryable: false })).toBe("not_found");
    expect(classifyProbeError({ kind: "rate_limit", message: "", retryable: true })).toBe("rate_limited");
    expect(classifyProbeError({ kind: "server", message: "", retryable: true })).toBe("unknown");
  });
});

describe("agent definition", () => {
  it("validates, applies defaults, and round-trips through YAML", () => {
    const v = validateAgentDefinition({ name: "Test Agent", slug: "test-agent", model: { alias: "default" }, instructions: "Be brief." });
    expect(v.ok).toBe(true);
    expect(v.definition?.budget.maxTurns).toBe(25);
    expect(v.definition?.sandbox).toBe(1);
    const y = agentToYaml(v.definition!);
    const back = validateAgentDefinition(agentFromYaml(y));
    expect(back.definition).toEqual(v.definition);
  });

  it("rejects approvals for tools that are not enabled and side-effect tools at sandbox 0", () => {
    const v = validateAgentDefinition({ name: "x", slug: "x", model: { alias: "a" }, instructions: "i", tools: ["shell"], approvals: ["file_write"], sandbox: 0 });
    expect(v.ok).toBe(false);
    const msgs = v.issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/not in tools/);
    expect(msgs).toMatch(/requires sandbox level 1/);
  });

  it("warns when side-effect tools run without approval", () => {
    const v = validateAgentDefinition({ name: "x", slug: "x", model: { alias: "a" }, instructions: "i", tools: ["shell"] });
    expect(v.ok).toBe(true);
    expect(v.issues.some((i) => i.severity === "warning" && /shell/.test(i.message))).toBe(true);
  });

  it("rejects bad slugs", () => {
    expect(validateAgentDefinition({ name: "x", slug: "Bad Slug", model: { alias: "a" }, instructions: "i" }).ok).toBe(false);
  });
});

describe("policy", () => {
  const def = validateAgentDefinition({ name: "x", slug: "x", model: { alias: "a" }, instructions: "i", tools: ["file_read", "shell"], approvals: ["shell"] }).definition!;
  const policy = policyForAgent(def, toolsFor(def.tools));
  it("allows read-only tools, gates approval-listed tools, denies unknown tools", () => {
    expect(policy.evaluate("file_read")).toEqual({ decision: "allow" });
    expect(policy.evaluate("shell")).toEqual({ decision: "require_approval" });
    expect(policy.evaluate("file_write").decision).toBe("deny");
    expect(policy.evaluate("rm_rf").decision).toBe("deny");
  });
});

describe("workspace jail", () => {
  const root = path.resolve("/tmp/ws");
  it("keeps relative paths inside and rejects escapes", () => {
    expect(resolveInWorkspace(root, "a/b.txt")).toBe(path.join(root, "a", "b.txt"));
    expect(resolveInWorkspace(root, ".")).toBe(root);
    expect(() => resolveInWorkspace(root, "../secret")).toThrow(/escapes/);
    expect(() => resolveInWorkspace(root, "a/../../x")).toThrow(/escapes/);
    expect(() => resolveInWorkspace(root, path.resolve("/etc/passwd"))).toThrow(/escapes/);
  });
});

describe("gateway resolver", () => {
  const conn: Connection = {
    id: "conn_1",
    name: "gw",
    profileId: "apim",
    kind: "gateway",
    baseUrl: "https://gw.example.com/",
    auth: { headerName: "Ocp-Apim-Subscription-Key" },
    extraHeaders: { "x-tenant": "t1" },
    secretLast4: "abcd",
    createdAt: "",
  };
  const model: Model = {
    id: "conn_1/gpt-5",
    connectionId: "conn_1",
    providerModelId: "gpt-5",
    bodyModel: "gpt-5-deploy",
    displayName: "GPT-5",
    dialect: "openai.chat",
    route: "/openai/deployments/gpt-5/chat/completions",
    query: { "api-version": "2025-04-01-preview" },
    capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
    status: "entitled",
    origin: "catalog",
  };
  it("builds the upstream URL, injects the key with the configured header, and keeps extra headers", () => {
    const t = resolveUpstream(conn, model, "secret-key");
    expect(t.url).toBe("https://gw.example.com/openai/deployments/gpt-5/chat/completions?api-version=2025-04-01-preview");
    expect(t.headers["Ocp-Apim-Subscription-Key"]).toBe("secret-key");
    expect(t.headers["x-tenant"]).toBe("t1");
    expect(t.bodyModel).toBe("gpt-5-deploy");
  });
  it("applies a bearer prefix when the auth spec has one", () => {
    const t = resolveUpstream({ ...conn, auth: { headerName: "Authorization", prefix: "Bearer " } }, model, "k");
    expect(t.headers.Authorization).toBe("Bearer k");
  });
  it("scopes proxy base URLs per connection and dialect", () => {
    expect(proxyBaseUrl("http://127.0.0.1:7777", "conn_1", "anthropic.messages")).toBe("http://127.0.0.1:7777/proxy/conn_1/anthropic");
    expect(proxyBaseUrl("http://127.0.0.1:7777/", "conn_1", "openai.chat")).toBe("http://127.0.0.1:7777/proxy/conn_1/openai/v1");
  });
});

describe("cost", () => {
  it("bills cached input at the cached rate", () => {
    const c = estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 }, { input: 2, output: 10, cachedInput: 0.2 });
    expect(c).toBeCloseTo(1.1, 6);
  });
  it("is zero without pricing", () => {
    expect(estimateCost({ inputTokens: 10, outputTokens: 10 })).toBe(0);
  });
});

describe("event projection", () => {
  it("rebuilds the conversation from persisted events only", () => {
    const base = { runId: "r", sessionId: "s", ts: "" };
    const events: RunEvent[] = [
      { ...base, id: 1, type: "run_started", agent: { slug: "a", version: 1 }, model: { connectionId: "c", modelId: "m", dialect: "openai.chat" } },
      { ...base, id: 2, type: "user_message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { ...base, id: 3, type: "assistant_message", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "file_read", input: {} }] }, stopReason: "tool_use" },
      { ...base, id: 4, type: "tool_result", callId: "t1", name: "file_read", output: "x", isError: false, durationMs: 1 },
      { ...base, id: 5, type: "tool_results_message", message: { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "x" }] } },
      { ...base, id: 6, type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "done" }] }, stopReason: "end_turn" },
    ];
    const msgs = projectMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[2].content[0].type).toBe("tool_result");
  });
});
