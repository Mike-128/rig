import type { Block, Message, RunEvent } from "../types";

/** The user message a compaction summary becomes when the conversation is rebuilt. */
export function summaryMessage(summary: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `This session is being continued from an earlier conversation that was summarized to free context. The summary:

${summary}

Continue from where it left off.`,
      },
    ],
  };
}

/** Rebuild the canonical conversation from a session's persisted events, in order. */
export function projectMessages(events: Iterable<Pick<RunEvent, "type"> & Record<string, unknown>>): Message[] {
  let messages: Message[] = [];
  for (const e of events) {
    if (e.type === "user_message" || e.type === "assistant_message" || e.type === "tool_results_message") {
      pushMessage(messages, e.message as Message);
    } else if (e.type === "compacted") {
      messages = [summaryMessage(String(e.summary))];
    }
  }
  return messages;
}

/**
 * Append, merging into the previous message when both are user turns (a compaction summary followed
 * by the next prompt). Providers expect alternating roles.
 */
export function pushMessage(messages: Message[], m: Message): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && m.role === "user" && !m.content.some((b) => b.type === "tool_result")) {
    messages[messages.length - 1] = { role: "user", content: [...last.content, ...m.content] };
  } else {
    messages.push(m);
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

/**
 * The conversation as plain text turns, for a request that must not call tools (compaction).
 * Tool calls and results become text, so the request needs no tool definitions or tool_choice,
 * which some gateways reject. Reasoning is dropped; images are kept.
 */
export function asPlainTranscript(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const content: Block[] = [];
    for (const b of m.content) {
      if (b.type === "text" || b.type === "image") content.push(b);
      else if (b.type === "tool_use") content.push({ type: "text", text: `[Called ${b.name} with ${clip(JSON.stringify(b.input ?? {}), 2000)}]` });
      else if (b.type === "tool_result") content.push({ type: "text", text: `[${b.isError ? "Error from" : "Result of"} that call: ${clip(b.content, 4000)}]` });
    }
    if (!content.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = [...last.content, ...content];
    else out.push({ role: m.role, content });
  }
  return out;
}

/** Rough token count (4 characters per token), for deciding when to compact before a request is sent. */
export function estimateTokens(messages: Message[], system = ""): number {
  let chars = system.length;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_result") chars += b.content.length;
      else if (b.type === "tool_use") chars += JSON.stringify(b.input ?? {}).length;
      else if (b.type === "reasoning") chars += b.text?.length ?? 0;
      else if (b.type === "image") chars += 6000;
    }
  }
  return Math.ceil(chars / 4);
}
