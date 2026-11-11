import type { AgentDefinition } from "../agent/schema";
import type { AdapterConnection, ProviderAdapter } from "../adapters/types";
import type { HostServices } from "../tools/host";
import type { SkillSummary } from "../skills/types";
import type { ToolContext, ToolResult, ToolSpec } from "../tools/types";
import {
  addUsage,
  emptyUsage,
  type ApprovalDecision,
  type Block,
  type CanonicalRequest,
  type Message,
  type Model,
  type RigError,
  type RunEventBody,
  type StopReason,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
} from "../types";
import { estimateTokens, pushMessage, summaryMessage } from "./context";
import { estimateCost } from "./cost";
import { allowRuleFor, type PermissionMode, type PolicyEvaluator } from "./policy";
import { buildSystemPrompt, type PromptContext } from "./prompt";

export interface EngineInput {
  agent: AgentDefinition;
  model: Model;
  adapter: ProviderAdapter;
  connection: AdapterConnection;
  /** Prior conversation, already projected from the session's events. */
  history: Message[];
  /** The new user turn. Omitted for a compaction-only run. */
  userTurn?: string;
  /** What to show for the user turn when it differs from what the model gets (an expanded /skill command). */
  userDisplay?: string;
  tools: ToolSpec[];
  policy: PolicyEvaluator;
  workspace: string;
  signal: AbortSignal;
  /** Skills installed on this machine; the agent's own list decides which are advertised. */
  skills?: SkillSummary[];
  /** Project instructions, platform facts, and the starting mode, for the system prompt. */
  prompt?: Omit<PromptContext, "workspace" | "skills">;
  /** Lends rig-management capabilities to tools that ask for them. */
  host?: HostServices;
  /** Suspends the run until the user decides. */
  requestApproval(callId: string, name: string, input: unknown): Promise<ApprovalDecision>;
  /** Records an "always allow" rule chosen in an approval. */
  onAllowRule?(rule: string): void;
  /** Messages the user sent while the run was working; drained at each turn boundary. */
  takeSteering?(): string[];
  /** Runs a sub-agent for the task tool. Absent inside a sub-agent, so nesting stops at one level. */
  runSubagent?: ToolContext["runSubagent"];
  /** Summarize the conversation and stop, instead of taking a turn. */
  compactOnly?: boolean;
  /** Compact when a request's input reaches this many tokens. Defaults to 80% of the context window. */
  compactAtTokens?: number;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

const COMPACT_SYSTEM =
  "You write handoff summaries of agent work sessions. Another instance of the agent will continue from your summary alone, so it must carry everything needed to keep going without re-reading the conversation.";

const COMPACT_REQUEST = `Summarize the conversation so far for handoff. Write it as a structured summary with these sections:

1. The user's requests and intent, in their words where it matters.
2. Key technical context: decisions made, conventions discovered, constraints.
3. Files examined or changed, with what matters about each (paths, key functions, the gist of edits).
4. Errors hit and how they were resolved.
5. Current state: what is done, what is in progress, and the exact next step.

Be specific (paths, names, commands, values), and omit pleasantries. Output only the summary.`;

type Progress = { kind: "progress"; callId: string; text: string } | { kind: "done"; call: ToolUseBlock; result: ToolResult; ms: number };

/**
 * The native agent loop: context -> model -> tools -> policy, until the model stops.
 * Yields RunEventBody values; the caller persists non-transient ones and streams all of them.
 */
export async function* runNativeEngine(input: EngineInput): AsyncGenerator<RunEventBody> {
  const { agent, model, adapter, connection, tools, policy, signal } = input;
  const messages: Message[] = [...input.history];
  const toolByName = new Map(tools.map((t) => [t.definition.name, t]));
  const system = buildSystemPrompt(agent, { ...input.prompt, workspace: input.workspace, skills: input.skills });
  const compactAt = input.compactAtTokens ?? Math.floor((model.capabilities.maxContextTokens ?? DEFAULT_CONTEXT_WINDOW) * 0.8);

  let cumulative: Usage = emptyUsage();
  let cost = 0;
  let turn = 0;
  let lastInputTokens = 0;

  const meter = (u: Usage): RunEventBody => {
    cumulative = addUsage(cumulative, u);
    const c = estimateCost(u, model.pricing);
    cost += c;
    return { type: "usage", usage: u, cumulative, costUsd: c };
  };
  const fail = (error: RigError): RunEventBody => ({ type: "run_failed", error, usage: cumulative, costUsd: cost });
  const done = (stopReason: StopReason): RunEventBody => ({ type: "run_completed", stopReason, usage: cumulative, costUsd: cost, turns: turn });

  /** Summarize everything so far and restart the conversation from the summary. */
  async function* compact(): AsyncGenerator<RunEventBody, boolean> {
    const tokensBefore = Math.max(lastInputTokens, estimateTokens(messages, system));
    const convo = [...messages];
    pushMessage(convo, { role: "user", content: [{ type: "text", text: COMPACT_REQUEST }] });
    const req: CanonicalRequest = {
      model: connection.modelId,
      system: COMPACT_SYSTEM,
      messages: convo,
      // Providers reject tool_use history without tool definitions, so keep them and forbid calls.
      tools: tools.length ? tools.map((t) => t.definition) : undefined,
      toolChoice: tools.length ? "none" : undefined,
      maxOutputTokens: Math.min(agent.params.maxOutputTokens ?? 8000, 8000),
    };
    let summary = "";
    let error: RigError | undefined;
    for await (const ev of adapter.stream(req, connection, model, signal)) {
      if (ev.type === "text_delta") summary += ev.text;
      else if (ev.type === "usage") yield meter(ev.usage);
      else if (ev.type === "error") error = ev.error;
    }
    if (error || !summary.trim()) {
      yield { type: "warning", message: `Could not compact the conversation: ${error?.message ?? "the model returned no summary"}` };
      return false;
    }
    messages.splice(0, messages.length, summaryMessage(summary.trim()));
    lastInputTokens = estimateTokens(messages, system);
    yield { type: "compacted", summary: summary.trim(), tokensBefore };
    return true;
  }

  if (input.compactOnly) {
    if (messages.length) yield* compact();
    else yield { type: "warning", message: "Nothing to compact yet." };
    yield done("end_turn");
    return;
  }

  if (input.userTurn !== undefined) {
    const userMessage: Message = { role: "user", content: [{ type: "text", text: input.userTurn }] };
    pushMessage(messages, userMessage);
    yield { type: "user_message", message: userMessage, display: input.userDisplay };
  }
  lastInputTokens = estimateTokens(messages, system);

  while (true) {
    if (signal.aborted) {
      yield { type: "run_cancelled", usage: cumulative, costUsd: cost };
      return;
    }
    if (turn >= agent.budget.maxTurns) {
      yield { type: "warning", message: `Turn budget of ${agent.budget.maxTurns} reached` };
      yield done("other");
      return;
    }
    if (lastInputTokens >= compactAt && messages.length > 1) yield* compact();

    turn += 1;
    yield { type: "turn_started", turn };

    const req: CanonicalRequest = {
      model: connection.modelId,
      system,
      messages,
      tools: tools.length ? tools.map((t) => t.definition) : undefined,
      toolChoice: tools.length ? "auto" : undefined,
      maxOutputTokens: agent.params.maxOutputTokens,
      temperature: agent.params.temperature,
      reasoning: agent.params.reasoningEffort ? { effort: agent.params.reasoningEffort } : undefined,
    };

    let assistant: Message | undefined;
    let stopReason: StopReason = "other";
    let turnError: RigError | undefined;

    for await (const ev of adapter.stream(req, connection, model, signal)) {
      switch (ev.type) {
        case "text_delta":
          yield { type: "text_delta", text: ev.text, transient: true };
          break;
        case "reasoning_delta":
          yield { type: "reasoning_delta", text: ev.text, transient: true };
          break;
        case "tool_use_start":
          yield { type: "tool_use_start", callId: ev.id, name: ev.name, transient: true };
          break;
        case "usage":
          lastInputTokens = ev.usage.inputTokens + (ev.usage.cachedInputTokens ?? 0) + (ev.usage.cacheWriteTokens ?? 0);
          yield meter(ev.usage);
          break;
        case "message_end":
          assistant = ev.message;
          stopReason = ev.stopReason;
          break;
        case "error":
          turnError = ev.error;
          break;
        default:
          break;
      }
    }

    if (turnError) {
      if (turnError.kind === "cancelled" || signal.aborted) yield { type: "run_cancelled", usage: cumulative, costUsd: cost };
      else yield fail(turnError);
      return;
    }
    if (!assistant) {
      yield fail({ kind: "unknown", message: "Model stream ended without a message", retryable: false });
      return;
    }

    messages.push(assistant);
    yield { type: "assistant_message", message: assistant, stopReason };

    const toolUses = assistant.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (stopReason !== "tool_use" || toolUses.length === 0) {
      // Messages the user typed while the model was answering become the next turn, not a new run.
      const steer = stopReason === "end_turn" ? (input.takeSteering?.() ?? []) : [];
      if (steer.length) {
        const m: Message = { role: "user", content: steer.map((text) => ({ type: "text", text })) };
        pushMessage(messages, m);
        yield { type: "user_message", message: m };
        continue;
      }
      if (stopReason === "refusal") yield { type: "warning", message: "The model declined to continue (refusal)" };
      if (stopReason === "max_tokens") yield { type: "warning", message: "Output was cut off at the max output token limit" };
      yield done(stopReason);
      return;
    }

    // Budgets are checked once per turn, after usage is known.
    if (agent.budget.tokens && cumulative.inputTokens + cumulative.outputTokens > agent.budget.tokens) {
      yield { type: "warning", message: `Token budget of ${agent.budget.tokens} exceeded` };
      yield done("other");
      return;
    }
    if (agent.budget.usd && cost > agent.budget.usd) {
      yield { type: "warning", message: `Cost budget of $${agent.budget.usd} exceeded` };
      yield done("other");
      return;
    }

    const results = yield* executeTools(toolUses);

    if (signal.aborted) {
      yield { type: "run_cancelled", usage: cumulative, costUsd: cost };
      return;
    }

    const content: Block[] = [...results];
    for (const text of input.takeSteering?.() ?? []) content.push({ type: "text", text });
    const resultMessage: Message = { role: "user", content };
    messages.push(resultMessage);
    yield { type: "tool_results_message", message: resultMessage };
  }

  /**
   * Runs one turn's tool calls. Read-only calls run concurrently in batches; side-effecting calls
   * and anything that needs approval run one at a time, in order. Results keep the call order.
   */
  async function* executeTools(calls: ToolUseBlock[]): AsyncGenerator<RunEventBody, ToolResultBlock[]> {
    const results = new Map<string, ToolResultBlock>();
    const settle = (call: ToolUseBlock, output: string, isError: boolean) =>
      results.set(call.id, { type: "tool_result", toolUseId: call.id, content: output, isError });
    let batch: ToolUseBlock[] = [];

    async function* runBatch(group: ToolUseBlock[]): AsyncGenerator<RunEventBody> {
      if (!group.length) return;
      const queue: Progress[] = [];
      let wake: (() => void) | undefined;
      const push = (p: Progress) => {
        queue.push(p);
        wake?.();
      };
      for (const call of group) {
        yield { type: "tool_call", callId: call.id, name: call.name, input: call.input };
        const spec = toolByName.get(call.name)!;
        const t0 = Date.now();
        const ctx: ToolContext = {
          workspace: input.workspace,
          sandbox: agent.sandbox,
          signal,
          host: input.host,
          enabledSkills: agent.skills,
          onProgress: (text) => push({ kind: "progress", callId: call.id, text }),
          runSubagent: input.runSubagent,
        };
        spec
          .run(call.input, ctx)
          .catch((e: Error) => ({ output: `Tool failed: ${e.message}`, isError: true }))
          .then((result) => push({ kind: "done", call, result, ms: Date.now() - t0 }));
      }
      let pending = group.length;
      while (pending > 0) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        while (queue.length) {
          const p = queue.shift()!;
          if (p.kind === "progress") {
            yield { type: "tool_progress", callId: p.callId, text: p.text, transient: true };
          } else {
            pending--;
            const isError = p.result.isError ?? false;
            settle(p.call, p.result.output, isError);
            yield { type: "tool_result", callId: p.call.id, name: p.call.name, output: p.result.output, isError, durationMs: p.ms };
          }
        }
      }
    }

    for (const call of calls) {
      if (signal.aborted) break;
      const decision = input.policy.evaluate(call.name, call.input);
      if (decision.decision === "deny") {
        yield { type: "tool_call", callId: call.id, name: call.name, input: call.input };
        yield { type: "tool_result", callId: call.id, name: call.name, output: decision.reason, isError: true, durationMs: 0 };
        settle(call, decision.reason, true);
        continue;
      }
      const spec = toolByName.get(call.name)!;
      if (decision.decision === "require_approval" || spec.sideEffect) {
        yield* runBatch(batch);
        batch = [];
      }
      if (decision.decision === "require_approval") {
        yield { type: "approval_requested", callId: call.id, name: call.name, input: call.input };
        const d = await input.requestApproval(call.id, call.name, call.input);
        const rule = d === "always" ? allowRuleFor(call.name, call.input) : undefined;
        if (rule) input.onAllowRule?.(rule);
        yield { type: "approval_resolved", callId: call.id, decision: d, rule };
        if (d === "deny") {
          const msg = signal.aborted ? "Cancelled" : "The user declined this tool call.";
          yield { type: "tool_result", callId: call.id, name: call.name, output: msg, isError: true, durationMs: 0 };
          settle(call, msg, true);
          continue;
        }
      }
      if (spec.sideEffect) yield* runBatch([call]);
      else batch.push(call);
    }
    yield* runBatch(batch);

    return calls.map((c) => results.get(c.id) ?? { type: "tool_result", toolUseId: c.id, content: "Cancelled", isError: true });
  }
}

/** Default mode for display when the caller does not say. */
export const DEFAULT_MODE: PermissionMode = "default";
