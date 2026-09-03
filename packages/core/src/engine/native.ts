import type { AgentDefinition } from "../agent/schema";
import type { AdapterConnection, ProviderAdapter } from "../adapters/types";
import type { HostServices } from "../tools/host";
import type { SkillSummary } from "../skills/types";
import type { ToolSpec } from "../tools/types";
import {
  addUsage,
  emptyUsage,
  type ApprovalDecision,
  type Block,
  type CanonicalRequest,
  type HarnessError,
  type Message,
  type Model,
  type RunEventBody,
  type StopReason,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
} from "../types";
import { estimateCost } from "./cost";
import type { PolicyEvaluator } from "./policy";
import { buildSystemPrompt } from "./prompt";

export interface EngineInput {
  agent: AgentDefinition;
  model: Model;
  adapter: ProviderAdapter;
  connection: AdapterConnection;
  /** Prior conversation, already projected from the session's events. */
  history: Message[];
  userTurn: string;
  tools: ToolSpec[];
  policy: PolicyEvaluator;
  workspace: string;
  signal: AbortSignal;
  /** Skills installed on this machine; the agent's own list decides which are advertised. */
  skills?: SkillSummary[];
  /** Lends harness-management capabilities to tools that ask for them. */
  host?: HostServices;
  /** Suspends the run until the user decides. */
  requestApproval(callId: string, name: string, input: unknown): Promise<ApprovalDecision>;
  /** Called when a turn's stream reaches its end so the caller can see the final message. */
  now?: () => string;
}

/**
 * The native agent loop: context -> model -> tools -> policy, until the model stops.
 * Yields RunEventBody values; the caller persists non-transient ones and streams all of them.
 */
export async function* runNativeEngine(input: EngineInput): AsyncGenerator<RunEventBody> {
  const { agent, model, adapter, connection, tools, policy, signal } = input;
  const messages: Message[] = [...input.history, { role: "user", content: [{ type: "text", text: input.userTurn }] }];
  const toolByName = new Map(tools.map((t) => [t.definition.name, t]));
  const system = buildSystemPrompt(agent, { workspace: input.workspace, skills: input.skills });

  let cumulative: Usage = emptyUsage();
  let cost = 0;
  let turn = 0;

  yield { type: "user_message", message: messages[messages.length - 1] };

  const fail = (error: HarnessError): RunEventBody => ({ type: "run_failed", error, usage: cumulative, costUsd: cost });

  while (true) {
    if (signal.aborted) {
      yield { type: "run_cancelled", usage: cumulative, costUsd: cost };
      return;
    }
    if (turn >= agent.budget.maxTurns) {
      yield { type: "warning", message: `Turn budget of ${agent.budget.maxTurns} reached` };
      yield { type: "run_completed", stopReason: "other", usage: cumulative, costUsd: cost, turns: turn };
      return;
    }
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
    let turnError: HarnessError | undefined;

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
        case "usage": {
          cumulative = addUsage(cumulative, ev.usage);
          const c = estimateCost(ev.usage, model.pricing);
          cost += c;
          yield { type: "usage", usage: ev.usage, cumulative, costUsd: c };
          break;
        }
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
      if (turnError.kind === "cancelled" || signal.aborted) {
        yield { type: "run_cancelled", usage: cumulative, costUsd: cost };
      } else {
        yield fail(turnError);
      }
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
      if (stopReason === "refusal") yield { type: "warning", message: "The model declined to continue (refusal)" };
      if (stopReason === "max_tokens") yield { type: "warning", message: "Output was cut off at the max output token limit" };
      yield { type: "run_completed", stopReason, usage: cumulative, costUsd: cost, turns: turn };
      return;
    }

    // Budgets are checked once per turn, after usage is known.
    if (agent.budget.tokens && cumulative.inputTokens + cumulative.outputTokens > agent.budget.tokens) {
      yield { type: "warning", message: `Token budget of ${agent.budget.tokens} exceeded` };
      yield { type: "run_completed", stopReason: "other", usage: cumulative, costUsd: cost, turns: turn };
      return;
    }
    if (agent.budget.usd && cost > agent.budget.usd) {
      yield { type: "warning", message: `Cost budget of $${agent.budget.usd} exceeded` };
      yield { type: "run_completed", stopReason: "other", usage: cumulative, costUsd: cost, turns: turn };
      return;
    }

    const results: ToolResultBlock[] = [];
    for (const call of toolUses) {
      if (signal.aborted) break;
      const decision = policy.evaluate(call.name);
      if (decision.decision === "deny") {
        yield { type: "tool_call", callId: call.id, name: call.name, input: call.input };
        yield { type: "tool_result", callId: call.id, name: call.name, output: decision.reason, isError: true, durationMs: 0 };
        results.push({ type: "tool_result", toolUseId: call.id, content: decision.reason, isError: true });
        continue;
      }
      if (decision.decision === "require_approval") {
        yield { type: "approval_requested", callId: call.id, name: call.name, input: call.input };
        const d = await input.requestApproval(call.id, call.name, call.input);
        yield { type: "approval_resolved", callId: call.id, decision: d };
        if (d === "deny") {
          const msg = "The user declined this tool call.";
          yield { type: "tool_result", callId: call.id, name: call.name, output: msg, isError: true, durationMs: 0 };
          results.push({ type: "tool_result", toolUseId: call.id, content: msg, isError: true });
          continue;
        }
      }
      yield { type: "tool_call", callId: call.id, name: call.name, input: call.input };
      const spec = toolByName.get(call.name)!;
      const t0 = Date.now();
      let output: string;
      let isError = false;
      try {
        const r = await spec.run(call.input, {
          workspace: input.workspace,
          sandbox: agent.sandbox,
          signal,
          host: input.host,
          enabledSkills: agent.skills,
        });
        output = r.output;
        isError = r.isError ?? false;
      } catch (e) {
        output = `Tool failed: ${(e as Error).message}`;
        isError = true;
      }
      yield { type: "tool_result", callId: call.id, name: call.name, output, isError, durationMs: Date.now() - t0 };
      results.push({ type: "tool_result", toolUseId: call.id, content: output, isError });
    }

    if (signal.aborted) {
      yield { type: "run_cancelled", usage: cumulative, costUsd: cost };
      return;
    }

    const resultMessage: Message = { role: "user", content: results as Block[] };
    messages.push(resultMessage);
    yield { type: "tool_results_message", message: resultMessage };
  }
}
