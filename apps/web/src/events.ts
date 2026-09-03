import type { RunEvent, Usage } from "@rig/core/types";

export type ThreadItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; reasoning?: string; live?: boolean }
  | { kind: "tool"; key: string; callId: string; name: string; input: unknown; output?: string; isError?: boolean; durationMs?: number }
  | { kind: "approval"; key: string; runId: string; callId: string; name: string; input: unknown; decision?: "approve" | "deny" }
  | { kind: "notice"; key: string; level: "warning" | "error" | "info"; text: string };

export interface ThreadState {
  items: ThreadItem[];
  activeRunId?: string;
  status: "idle" | "running" | "awaiting_approval";
  usage: Usage;
  costUsd: number;
  lastEventId: number;
  live: { text: string; reasoning: string; runId?: string };
}

export function emptyThread(): ThreadState {
  return { items: [], status: "idle", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, lastEventId: 0, live: { text: "", reasoning: "" } };
}

function textOf(message: { content: { type: string; text?: string }[] }): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

function reasoningOf(message: { content: { type: string; text?: string }[] }): string {
  return message.content
    .filter((b) => b.type === "reasoning")
    .map((b) => b.text ?? "")
    .join("");
}

/** Fold one event into the view model. Pure; safe to replay. */
export function reduceEvent(s: ThreadState, ev: RunEvent): ThreadState {
  const items = s.items.slice();
  const next: ThreadState = { ...s, items };
  if (ev.id !== undefined) next.lastEventId = Math.max(s.lastEventId, ev.id);
  const key = `${ev.runId}:${ev.id ?? Math.random()}`;
  switch (ev.type) {
    case "run_started":
      next.activeRunId = ev.runId;
      next.status = "running";
      next.live = { text: "", reasoning: "", runId: ev.runId };
      break;
    case "user_message":
      items.push({ kind: "user", key, text: textOf(ev.message) });
      break;
    case "text_delta":
      next.live = { ...s.live, text: s.live.text + ev.text, runId: ev.runId };
      break;
    case "reasoning_delta":
      next.live = { ...s.live, reasoning: s.live.reasoning + ev.text, runId: ev.runId };
      break;
    case "assistant_message": {
      const text = textOf(ev.message);
      const reasoning = reasoningOf(ev.message);
      if (text || reasoning) items.push({ kind: "assistant", key, text, reasoning: reasoning || undefined });
      next.live = { text: "", reasoning: "", runId: ev.runId };
      break;
    }
    case "tool_call":
      items.push({ kind: "tool", key, callId: ev.callId, name: ev.name, input: ev.input });
      break;
    case "tool_result": {
      const idx = items.findIndex((i) => i.kind === "tool" && i.callId === ev.callId && i.output === undefined);
      const merged = { kind: "tool" as const, key: idx >= 0 ? items[idx].key : key, callId: ev.callId, name: ev.name, input: idx >= 0 ? (items[idx] as { input: unknown }).input : undefined, output: ev.output, isError: ev.isError, durationMs: ev.durationMs };
      if (idx >= 0) items[idx] = merged;
      else items.push(merged);
      break;
    }
    case "approval_requested":
      items.push({ kind: "approval", key, runId: ev.runId, callId: ev.callId, name: ev.name, input: ev.input });
      next.status = "awaiting_approval";
      break;
    case "approval_resolved": {
      const idx = items.findIndex((i) => i.kind === "approval" && i.callId === ev.callId);
      if (idx >= 0) items[idx] = { ...(items[idx] as Extract<ThreadItem, { kind: "approval" }>), decision: ev.decision };
      next.status = "running";
      break;
    }
    case "usage":
      next.usage = ev.cumulative;
      next.costUsd = s.costUsd + ev.costUsd;
      break;
    case "warning":
      items.push({ kind: "notice", key, level: "warning", text: ev.message });
      break;
    case "run_completed":
      next.status = "idle";
      next.activeRunId = undefined;
      next.live = { text: "", reasoning: "" };
      break;
    case "run_failed":
      items.push({ kind: "notice", key, level: "error", text: `Run failed: ${ev.error.message}` });
      next.status = "idle";
      next.activeRunId = undefined;
      next.live = { text: "", reasoning: "" };
      break;
    case "run_cancelled":
      items.push({ kind: "notice", key, level: "info", text: "Run cancelled" });
      next.status = "idle";
      next.activeRunId = undefined;
      next.live = { text: "", reasoning: "" };
      break;
    default:
      break;
  }
  return next;
}

export function reduceAll(events: RunEvent[]): ThreadState {
  let s = emptyThread();
  for (const e of events) s = reduceEvent(s, e);
  // A persisted history has no live run unless the last run is still open.
  return s;
}
