// Canonical message model. Anthropic-shaped: content blocks, tool_use / tool_result.
// Every adapter maps to and from this; nothing provider-specific leaks above it.

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  data: string; // base64
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  /**
   * Opaque provider data that must be echoed back with this call on later turns.
   * Gemini 3 requires its `thought_signature` here, or the next request is a 400.
   */
  providerMeta?: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ReasoningBlock {
  type: "reasoning";
  text?: string;
  /** Provider-native block, replayed verbatim to the same provider (e.g. Anthropic thinking + signature). */
  opaque?: unknown;
}

export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock;

export interface Message {
  role: Role;
  content: Block[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export type ReasoningEffort = "low" | "medium" | "high";

export interface CanonicalRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
  maxOutputTokens?: number;
  temperature?: number;
  reasoning?: { effort?: ReasoningEffort };
  /** Provider-specific knobs an adapter may honor or ignore. Never core fields. */
  extensions?: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export type StreamEvent =
  | { type: "message_start" }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialJson: string }
  | { type: "tool_use_end"; id: string; name: string; input: unknown }
  | { type: "usage"; usage: Usage }
  | { type: "message_end"; stopReason: StopReason; message: Message; usage: Usage }
  | { type: "error"; error: RigError };

export type RigErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limit"
  | "server"
  | "network"
  | "cancelled"
  | "unknown";

export interface RigError {
  kind: RigErrorKind;
  message: string;
  status?: number;
  retryable: boolean;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

export function textOf(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
