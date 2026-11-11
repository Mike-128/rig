import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allowRuleFor,
  BUILTIN_TOOLS,
  policyForAgent,
  projectMessages,
  runNativeEngine,
  toolsFor,
  validateAgentDefinition,
  type AgentDefinition,
  type ApprovalDecision,
  type Block,
  type CanonicalRequest,
  type Model,
  type PermissionMode,
  type ProviderAdapter,
  type RunEventBody,
  type StopReason,
  type ToolContext,
} from "../src";

let ws: string;
const ctx = (): ToolContext => ({ workspace: ws, sandbox: 1, signal: new AbortController().signal });
const run = (name: keyof typeof BUILTIN_TOOLS, input: unknown) => BUILTIN_TOOLS[name].run(input, ctx());

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), "rig-agentic-"));
  mkdirSync(path.join(ws, "src", "lib"), { recursive: true });
  mkdirSync(path.join(ws, "node_modules", "dep"), { recursive: true });
  mkdirSync(path.join(ws, "dist"), { recursive: true });
  writeFileSync(path.join(ws, ".gitignore"), "dist/\n*.log\n");
  writeFileSync(path.join(ws, "src", "app.ts"), "export function main() {\n  return helper(1);\n}\n");
  writeFileSync(path.join(ws, "src", "lib", "helper.ts"), "export function helper(x: number) {\n  return x + 1;\n}\n");
  writeFileSync(path.join(ws, "node_modules", "dep", "index.ts"), "export function helper() {}\n");
  writeFileSync(path.join(ws, "dist", "app.js"), "function helper() {}\n");
  writeFileSync(path.join(ws, "debug.log"), "helper\n");
  writeFileSync(path.join(ws, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe("coding tools", () => {
  it("file_read numbers lines and reads ranges", async () => {
    expect((await run("file_read", { path: "src/app.ts" })).output).toBe("1\texport function main() {\n2\t  return helper(1);\n3\t}");
    const r = await run("file_read", { path: "src/app.ts", offset: 2, limit: 1 });
    expect(r.output).toMatch(/^2\t {2}return helper\(1\);\n\n\[lines 2-2 of 3; read further with offset 3\]$/);
  });

  it("file_edit replaces a unique match, refuses ambiguous ones, and keeps CRLF", async () => {
    writeFileSync(path.join(ws, "edit.txt"), "a = 1\nb = 1\n");
    expect((await run("file_edit", { path: "edit.txt", old_string: "= 1", new_string: "= 2" })).isError).toBe(true);
    expect((await run("file_edit", { path: "edit.txt", old_string: "b = 1", new_string: "b = 2" })).output).toMatch(/line 2/);
    expect(readFileSync(path.join(ws, "edit.txt"), "utf8")).toBe("a = 1\nb = 2\n");
    await run("file_edit", { path: "edit.txt", old_string: "= ", new_string: ":= ", replace_all: true });
    expect(readFileSync(path.join(ws, "edit.txt"), "utf8")).toBe("a := 1\nb := 2\n");
    await run("file_edit", { path: "crlf.txt", old_string: "one\ntwo", new_string: "uno\ndos" });
    expect(readFileSync(path.join(ws, "crlf.txt"), "utf8")).toBe("uno\r\ndos\r\nthree\r\n");
    expect((await run("file_edit", { path: "../escape.txt", old_string: "x", new_string: "y" })).isError).toBe(true);
  });

  it("glob finds files and skips node_modules and .gitignored paths", async () => {
    const out = (await run("glob", { pattern: "**/*.ts" })).output.split("\n").sort();
    expect(out).toEqual(["src/app.ts", "src/lib/helper.ts"]);
    expect((await run("glob", { pattern: "*.ts", path: "src/lib" })).output).toBe("src/lib/helper.ts");
  });

  it("grep searches contents in each output mode", async () => {
    const files = (await run("grep", { pattern: "helper" })).output;
    expect(files).toMatch(/src\/app\.ts/);
    expect(files).toMatch(/src\/lib\/helper\.ts/);
    expect(files).not.toMatch(/node_modules|dist|debug\.log/);
    expect((await run("grep", { pattern: "return", output_mode: "content", glob: "**/app.ts" })).output).toBe("src/app.ts:2:  return helper(1);");
    expect((await run("grep", { pattern: "HELPER", ignore_case: true, output_mode: "count", path: "src/lib" })).output).toBe("src/lib/helper.ts:1");
    expect((await run("grep", { pattern: "(" })).isError).toBe(true);
  });
});

const agent = (over: Partial<AgentDefinition> = {}): AgentDefinition =>
  validateAgentDefinition({
    name: "T",
    slug: "t",
    model: { alias: "default" },
    instructions: "Test agent.",
    tools: ["file_read", "file_edit", "shell", "glob"],
    approvals: ["file_edit", "shell"],
    ...over,
  }).definition!;

describe("permission modes and rules", () => {
  const evaluate = (mode: PermissionMode, rules: string[], tool: string, input?: unknown) =>
    policyForAgent(agent(), toolsFor(agent().tools), { mode: () => mode, rules: () => rules }).evaluate(tool, input).decision;

  it("applies each mode", () => {
    expect(evaluate("default", [], "file_edit")).toBe("require_approval");
    expect(evaluate("default", [], "file_read")).toBe("allow");
    expect(evaluate("acceptEdits", [], "file_edit")).toBe("allow");
    expect(evaluate("acceptEdits", [], "shell", { command: "ls" })).toBe("require_approval");
    expect(evaluate("plan", [], "file_edit")).toBe("deny");
    expect(evaluate("plan", [], "glob")).toBe("allow");
    expect(evaluate("auto", [], "shell", { command: "rm -rf x" })).toBe("allow");
    expect(evaluate("auto", [], "web_fetch")).toBe("deny");
  });

  it("scopes shell rules to a command prefix and never to a chained command", () => {
    expect(allowRuleFor("shell", { command: "npm test -- --watch" })).toBe("shell:npm test");
    expect(allowRuleFor("shell", { command: "ls -la" })).toBe("shell:ls");
    expect(allowRuleFor("file_edit", {})).toBe("file_edit");
    const rules = ["shell:npm test"];
    expect(evaluate("default", rules, "shell", { command: "npm test" })).toBe("allow");
    expect(evaluate("default", rules, "shell", { command: "npm test -- -t foo" })).toBe("allow");
    expect(evaluate("default", rules, "shell", { command: "npm testx" })).toBe("require_approval");
    expect(evaluate("default", rules, "shell", { command: "npm test && rm -rf /" })).toBe("require_approval");
    expect(evaluate("default", ["file_edit"], "file_edit")).toBe("allow");
  });

  it("accepts every-skill and MCP tool names in agent definitions", () => {
    const v = validateAgentDefinition({ name: "x", slug: "x", model: { alias: "a" }, instructions: "i", tools: ["load_skill", "mcp__github__*", "mcp__fs__read_file"], skills: ["*"] });
    expect(v.ok).toBe(true);
    expect(validateAgentDefinition({ name: "x", slug: "x", model: { alias: "a" }, instructions: "i", tools: ["nope"] }).ok).toBe(false);
  });
});

/** A scripted model: each call returns the next response, and records what it was sent. */
function scripted(responses: { content: Block[]; stop: StopReason; inputTokens?: number }[] | ((req: CanonicalRequest) => { content: Block[]; stop: StopReason; inputTokens?: number })) {
  const requests: CanonicalRequest[] = [];
  const adapter: ProviderAdapter = {
    dialect: "anthropic.messages",
    async *stream(req) {
      requests.push(structuredClone(req));
      const r = typeof responses === "function" ? responses(req) : responses.shift()!;
      for (const b of r.content) if (b.type === "text") yield { type: "text_delta", text: b.text };
      const usage = { inputTokens: r.inputTokens ?? 100, outputTokens: 10 };
      yield { type: "usage", usage };
      yield { type: "message_end", stopReason: r.stop, message: { role: "assistant", content: r.content }, usage };
    },
    probe: async () => ({ status: "entitled", latencyMs: 0 }),
    listModels: async () => [],
    normalizeError: (e) => ({ kind: "unknown", message: String(e), retryable: false }),
  };
  return { adapter, requests };
}

const model: Model = {
  id: "c/m",
  connectionId: "c",
  providerModelId: "m",
  bodyModel: "m",
  displayName: "m",
  dialect: "anthropic.messages",
  route: "/v1/messages",
  capabilities: { streaming: true, tools: true, vision: false, reasoning: false, maxContextTokens: 10_000 },
  status: "entitled",
  origin: "manual",
};

async function collect(gen: AsyncGenerator<RunEventBody>): Promise<RunEventBody[]> {
  const out: RunEventBody[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function engine(a: AgentDefinition, adapter: ProviderAdapter, extra: Partial<Parameters<typeof runNativeEngine>[0]> = {}) {
  const tools = toolsFor(a.tools);
  return runNativeEngine({
    agent: a,
    model,
    adapter,
    connection: { baseUrl: "http://x", headers: {}, modelId: "m" },
    history: [],
    userTurn: "go",
    tools,
    policy: policyForAgent(a, tools),
    workspace: ws,
    signal: new AbortController().signal,
    requestApproval: async (): Promise<ApprovalDecision> => "approve",
    ...extra,
  });
}

describe("engine", () => {
  it("runs a turn's read-only calls concurrently and keeps result order", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = {
      ...BUILTIN_TOOLS.glob,
      definition: { ...BUILTIN_TOOLS.glob.definition, name: "glob" },
      async run() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return { output: "ok" };
      },
    };
    const a = agent({ tools: ["glob"], approvals: [] });
    const { adapter, requests } = scripted([
      {
        stop: "tool_use",
        content: [
          { type: "tool_use", id: "a", name: "glob", input: { pattern: "1" } },
          { type: "tool_use", id: "b", name: "glob", input: { pattern: "2" } },
          { type: "tool_use", id: "c", name: "glob", input: { pattern: "3" } },
        ],
      },
      { stop: "end_turn", content: [{ type: "text", text: "done" }] },
    ]);
    const events = await collect(engine(a, adapter, { tools: [slow], policy: policyForAgent(a, [slow]) }));
    expect(peak).toBe(3);
    const results = requests[1].messages.at(-1)!.content.map((b) => (b.type === "tool_result" ? b.toolUseId : ""));
    expect(results).toEqual(["a", "b", "c"]);
    expect(events.at(-1)?.type).toBe("run_completed");
  });

  it("records an always-allow rule and stops asking for matching calls", async () => {
    const a = agent();
    const rules: string[] = [];
    const asked: string[] = [];
    const tools = toolsFor(a.tools);
    const { adapter } = scripted([
      { stop: "tool_use", content: [{ type: "tool_use", id: "1", name: "shell", input: { command: "echo one" } }] },
      { stop: "tool_use", content: [{ type: "tool_use", id: "2", name: "shell", input: { command: "echo one two" } }] },
      { stop: "end_turn", content: [{ type: "text", text: "done" }] },
    ]);
    const events = await collect(
      engine(a, adapter, {
        tools,
        policy: policyForAgent(a, tools, { rules: () => rules }),
        onAllowRule: (r) => rules.push(r),
        requestApproval: async (id) => {
          asked.push(id);
          return "always";
        },
      }),
    );
    expect(asked).toEqual(["1"]);
    expect(rules).toEqual(["shell:echo one"]);
    expect(events.filter((e) => e.type === "tool_result").length).toBe(2);
  });

  it("delivers steering messages at the next turn boundary", async () => {
    const a = agent({ tools: ["glob"], approvals: [] });
    const inbox = ["also check the tests"];
    const { adapter, requests } = scripted([
      { stop: "tool_use", content: [{ type: "tool_use", id: "1", name: "glob", input: { pattern: "**/*.ts" } }] },
      { stop: "end_turn", content: [{ type: "text", text: "done" }] },
    ]);
    await collect(engine(a, adapter, { takeSteering: () => inbox.splice(0) }));
    const last = requests[1].messages.at(-1)!;
    expect(last.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(last.content[1]).toEqual({ type: "text", text: "also check the tests" });
  });

  it("turns a steering message that arrives after the answer into the next turn", async () => {
    const a = agent({ tools: [], approvals: [] });
    let sent = false;
    const { adapter, requests } = scripted([
      { stop: "end_turn", content: [{ type: "text", text: "first" }] },
      { stop: "end_turn", content: [{ type: "text", text: "second" }] },
    ]);
    const events = await collect(
      engine(a, adapter, {
        takeSteering: () => {
          if (sent) return [];
          sent = true;
          return ["one more thing"];
        },
      }),
    );
    expect(requests).toHaveLength(2);
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(2);
    expect(events.filter((e) => e.type === "run_completed")).toHaveLength(1);
  });

  it("compacts when the context fills, and the projection restarts from the summary", async () => {
    const a = agent({ tools: ["glob"], approvals: [] });
    let calls = 0;
    const { adapter, requests } = scripted((req) => {
      calls++;
      if (req.system?.startsWith("You write handoff summaries")) return { stop: "end_turn", content: [{ type: "text", text: "SUMMARY: user wants X" }] };
      if (calls === 1) return { stop: "tool_use", inputTokens: 9_000, content: [{ type: "tool_use", id: "1", name: "glob", input: { pattern: "*" } }] };
      return { stop: "end_turn", content: [{ type: "text", text: "done" }] };
    });
    const events = await collect(engine(a, adapter));
    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toMatchObject({ summary: "SUMMARY: user wants X", tokensBefore: 9_000 });
    const after = requests.at(-1)!;
    expect(after.messages).toHaveLength(1);
    expect(JSON.stringify(after.messages[0])).toContain("SUMMARY: user wants X");
    const projected = projectMessages(events.filter((e) => !("transient" in e)) as never);
    expect(projected[0].content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(projected[0])).toContain("SUMMARY: user wants X");
    expect(projected.at(-1)?.role).toBe("assistant");
  });

  it("refuses side-effecting tools in plan mode and tells the model why", async () => {
    const a = agent();
    const tools = toolsFor(a.tools);
    const { adapter } = scripted([
      { stop: "tool_use", content: [{ type: "tool_use", id: "1", name: "shell", input: { command: "echo hi" } }] },
      { stop: "end_turn", content: [{ type: "text", text: "plan" }] },
    ]);
    const events = await collect(engine(a, adapter, { tools, policy: policyForAgent(a, tools, { mode: () => "plan" }), prompt: { mode: "plan" } }));
    const result = events.find((e) => e.type === "tool_result") as Extract<RunEventBody, { type: "tool_result" }>;
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Plan mode/);
  });
});
