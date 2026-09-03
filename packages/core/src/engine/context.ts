import type { Message, RunEvent } from "../types";

/** Rebuild the canonical conversation from a session's persisted events, in order. */
export function projectMessages(events: Iterable<Pick<RunEvent, "type"> & Record<string, unknown>>): Message[] {
  const messages: Message[] = [];
  for (const e of events) {
    if (e.type === "user_message" || e.type === "assistant_message" || e.type === "tool_results_message") {
      messages.push(e.message as Message);
    }
  }
  return messages;
}
