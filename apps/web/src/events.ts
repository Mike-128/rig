import type { ApprovalDecision, Message, RunEvent, Usage } from "@rig/core/types";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface ToolItem {
  kind: "tool";
  key: string;
  callId: string;
  runId: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  durationMs?: number;
  /** Live output while running (shell output, sub-agent progress). Not persisted. */
  progress: string;
  status: "awaiting_approval" | "running" | "done";
  approval?: { decision?: ApprovalDecision; rule?: string };
}

export type ThreadItem =
  | { kind: "user"; key: string; text: string; display?: string; steered?: boolean }
  | { kind: "assistant"; key: string; text: string; reasoning?: string; latencyMs?: number }
  | ToolItem
  | { kind: "notice"; key: string; level: "warning" | "error" | "info"; text: string }
  | { kind: "compacted"; key: string; summary: string; tokensBefore: number };

export interface ThreadState {
  items: ThreadItem[];
  activeRunId?: string;
  status: "idle" | "running" | "awaiting_approval";
  /** Totals for the session, across runs. */
  usage: Usage;
  costUsd: number;
  /** Size of the last request's input: how full the context window is. */
  contextTokens: number;
  contextWindow?: number;
  model?: string;
  lastEventId: number;
  live: { text: string; reasoning: string; tool?: string };
  /** The newest todo_write list. */
  todos: Todo[];
  /** When the current model turn began, to show each reply's latency. */
  turnTiming?: { runId: string; startedAt: number };
}

export function emptyThread(): ThreadState {
  return {
    items: [],
    status: "idle",
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    contextTokens: 0,
    lastEventId: 0,
    live: { text: "", reasoning: "" },
    todos: [],
  };
}

const textOf = (m: Message) =>
  m.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");

const reasoningOf = (m: Message) =>
  m.content
    .filter((b) => b.type === "reasoning")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("");

/**
 * Updates the open card for a call, or adds one. Matching is by run and call id among calls that have
 * not finished: some providers reuse ids like "call_0" on every turn, so a finished card with the
 * same id belongs to an earlier call.
 */
function upsertTool(items: ThreadItem[], runId: string, callId: string, make: () => ToolItem, patch: (t: ToolItem) => Partial<ToolItem>): void {
  let idx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.runId === runId && it.callId === callId && it.status !== "done") {
      idx = i;
      break;
    }
  }
  if (idx >= 0) items[idx] = { ...(items[idx] as ToolItem), ...patch(items[idx] as ToolItem) };
  else {
    const t = make();
    items.push({ ...t, ...patch(t) });
  }
}

const ended = (s: ThreadState): Partial<ThreadState> => ({ status: "idle", activeRunId: undefined, turnTiming: undefined, live: { text: "", reasoning: "" } });

/** Fold one event into the view model. Pure; safe to replay. */
export function reduceEvent(s: ThreadState, ev: RunEvent): ThreadState {
  const items = s.items.slice();
  let next: ThreadState = { ...s, items };
  if (ev.id !== undefined) next.lastEventId = Math.max(s.lastEventId, ev.id);
  const key = `${ev.runId}:${ev.id ?? `t${s.items.length}`}`;
  const tool = (callId: string, name: string, input: unknown): (() => ToolItem) => () => ({
    kind: "tool",
    key: `${ev.runId}:${callId}:${s.items.length}`,
    callId,
    runId: ev.runId,
    name,
    input,
    progress: "",
    status: "running",
  });

  switch (ev.type) {
    case "run_started":
      next.turnTiming = undefined;
      next.activeRunId = ev.runId;
      next.status = "running";
      next.model = ev.model.modelId;
      if (ev.model.contextWindow) next.contextWindow = ev.model.contextWindow;
      next.live = { text: "", reasoning: "" };
      break;
    case "turn_started":
      next.turnTiming = { runId: ev.runId, startedAt: Date.parse(ev.ts) };
      break;
    case "user_message":
      items.push({ kind: "user", key, text: textOf(ev.message), display: ev.display });
      break;
    case "text_delta":
      next.live = { ...s.live, text: s.live.text + ev.text, tool: undefined };
      break;
    case "reasoning_delta":
      next.live = { ...s.live, reasoning: s.live.reasoning + ev.text };
      break;
    case "tool_use_start":
      next.live = { ...s.live, tool: ev.name };
      break;
    case "assistant_message": {
      const text = textOf(ev.message);
      const reasoning = reasoningOf(ev.message);
      const elapsed = s.turnTiming?.runId === ev.runId ? Date.parse(ev.ts) - s.turnTiming.startedAt : NaN;
      const latencyMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
      if (text || reasoning) items.push({ kind: "assistant", key, text, reasoning: reasoning || undefined, latencyMs });
      next.turnTiming = undefined;
      next.live = { text: "", reasoning: "" };
      break;
    }
    case "approval_requested":
      upsertTool(items, ev.runId, ev.callId, tool(ev.callId, ev.name, ev.input), () => ({ status: "awaiting_approval", approval: {} }));
      next.status = "awaiting_approval";
      break;
    case "approval_resolved":
      upsertTool(items, ev.runId, ev.callId, tool(ev.callId, "", undefined), (t) => ({ status: ev.decision === "deny" ? "done" : t.status === "awaiting_approval" ? "running" : t.status, approval: { decision: ev.decision, rule: ev.rule } }));
      next.status = items.some((i) => i.kind === "tool" && i.status === "awaiting_approval") ? "awaiting_approval" : "running";
      break;
    case "tool_call":
      upsertTool(items, ev.runId, ev.callId, tool(ev.callId, ev.name, ev.input), () => ({ name: ev.name, input: ev.input, status: "running" }));
      if (ev.name === "todo_write") {
        const todos = (ev.input as { todos?: Todo[] } | undefined)?.todos;
        if (Array.isArray(todos)) next.todos = todos;
      }
      break;
    case "tool_progress":
      upsertTool(items, ev.runId, ev.callId, tool(ev.callId, "", undefined), (t) => ({ progress: (t.progress + ev.text).slice(-20_000) }));
      break;
    case "tool_result":
      upsertTool(items, ev.runId, ev.callId, tool(ev.callId, ev.name, undefined), () => ({ output: ev.output, isError: ev.isError, durationMs: ev.durationMs, status: "done" }));
      break;
    case "tool_results_message": {
      // Text alongside tool results is a message the user sent while the agent was working.
      const steer = textOf(ev.message);
      if (steer) items.push({ kind: "user", key, text: steer, steered: true });
      break;
    }
    case "usage":
      next.usage = ev.cumulative;
      next.costUsd = s.costUsd + ev.costUsd;
      next.contextTokens = ev.usage.inputTokens + (ev.usage.cachedInputTokens ?? 0) + (ev.usage.cacheWriteTokens ?? 0);
      break;
    case "warning":
      items.push({ kind: "notice", key, level: "warning", text: ev.message });
      break;
    case "compacted":
      items.push({ kind: "compacted", key, summary: ev.summary, tokensBefore: ev.tokensBefore });
      next.contextTokens = Math.ceil(ev.summary.length / 4);
      break;
    case "run_completed":
      next = { ...next, ...ended(s) };
      break;
    case "run_failed":
      items.push({ kind: "notice", key, level: "error", text: ev.error.message });
      next = { ...next, ...ended(s) };
      break;
    case "run_cancelled":
      items.push({ kind: "notice", key, level: "info", text: "Stopped." });
      next = { ...next, ...ended(s) };
      break;
    default:
      break;
  }
  if (next.status === "idle") {
    // Anything still marked running when a run ends was interrupted.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "tool" && it.status !== "done") items[i] = { ...it, status: "done", isError: true, output: it.output ?? "Interrupted" };
    }
  }
  return next;
}

export function reduceAll(events: RunEvent[]): ThreadState {
  let s = emptyThread();
  for (const e of events) s = reduceEvent(s, e);
  return s;
}
