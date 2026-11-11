import type { RigError, Message, StopReason, Usage } from "./canonical";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

/** "always" approves this call and records an allow rule so matching calls stop asking. */
export type ApprovalDecision = "approve" | "deny" | "always";

/**
 * Run events. Persisted events form the append-only log a session is rebuilt from.
 * Transient events (deltas) are streamed live and never stored.
 */
export type RunEventBody =
  | {
      type: "run_started";
      agent: { slug: string; version: number };
      model: { connectionId: string; modelId: string; dialect: string; contextWindow?: number };
    }
  /** display is what the user typed when it differs from what the model got (an expanded /skill command). */
  | { type: "user_message"; message: Message; display?: string }
  | { type: "turn_started"; turn: number }
  | { type: "text_delta"; text: string; transient: true }
  | { type: "reasoning_delta"; text: string; transient: true }
  | { type: "tool_use_start"; callId: string; name: string; transient: true }
  /** Partial output from a running tool: shell output, sub-agent progress. */
  | { type: "tool_progress"; callId: string; text: string; transient: true }
  | { type: "assistant_message"; message: Message; stopReason: StopReason }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "approval_requested"; callId: string; name: string; input: unknown }
  | { type: "approval_resolved"; callId: string; decision: ApprovalDecision; rule?: string }
  | { type: "tool_result"; callId: string; name: string; output: string; isError: boolean; durationMs: number }
  | { type: "tool_results_message"; message: Message }
  | { type: "usage"; usage: Usage; cumulative: Usage; costUsd: number }
  | { type: "warning"; message: string }
  /**
   * Earlier conversation was summarized to free context. The projection restarts from this summary,
   * so everything before it stays in the log for the record but is no longer sent to the model.
   */
  | { type: "compacted"; summary: string; tokensBefore: number }
  | { type: "run_completed"; stopReason: StopReason; usage: Usage; costUsd: number; turns: number }
  | { type: "run_failed"; error: RigError; usage: Usage; costUsd: number }
  | { type: "run_cancelled"; usage: Usage; costUsd: number };

export type RunEvent = RunEventBody & {
  /** Global ordering id assigned on persistence; undefined for transient events. */
  id?: number;
  runId: string;
  sessionId: string;
  ts: string;
};

export function isTransient(e: RunEventBody): boolean {
  return "transient" in e && e.transient === true;
}

export const TERMINAL_EVENTS = new Set(["run_completed", "run_failed", "run_cancelled"]);
