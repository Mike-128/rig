import type { RunEvent } from "@rig/core/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

const EVENT_TYPES = [
  "run_started",
  "user_message",
  "turn_started",
  "text_delta",
  "reasoning_delta",
  "tool_use_start",
  "assistant_message",
  "tool_call",
  "approval_requested",
  "approval_resolved",
  "tool_result",
  "tool_results_message",
  "usage",
  "warning",
  "run_completed",
  "run_failed",
  "run_cancelled",
];

/** Subscribe to a session's live events. Returns an unsubscribe function. */
export function streamSession(sessionId: string, after: number, onEvent: (ev: RunEvent) => void, onError?: () => void): () => void {
  const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream?after=${after}`);
  for (const t of EVENT_TYPES) es.addEventListener(t, (e) => onEvent(JSON.parse((e as MessageEvent).data) as RunEvent));
  es.onerror = () => onError?.();
  return () => es.close();
}
