import type { Dialect, EntitlementStatus, RigError } from "../types";

export interface ProbeResult {
  status: EntitlementStatus;
  message?: string;
  /** The HTTP status the provider answered with, when there was an answer. */
  httpStatus?: number;
  latencyMs: number;
}

const DIALECT_LABEL: Record<Dialect, string> = { "anthropic.messages": "Anthropic Messages", "openai.chat": "OpenAI Chat Completions" };

/**
 * A successful answer can still be the wrong kind: a route for one dialect answered by a model
 * configured for the other. Returns why the body does not fit, or undefined when it does.
 */
export function probeShapeProblem(dialect: Dialect, body: unknown): string | undefined {
  const b = (body ?? {}) as { choices?: unknown; type?: unknown; content?: unknown };
  const fits = dialect === "openai.chat" ? Array.isArray(b.choices) : b.type === "message" || Array.isArray(b.content);
  if (fits) return undefined;
  return `The provider answered, but not in the ${DIALECT_LABEL[dialect]} format this model is set to, so chats will fail. Check the model's dialect: routes ending in /messages take Anthropic Messages, and /chat/completions takes OpenAI Chat Completions.`;
}

/**
 * Classify a probe outcome. A validation error (400) still proves the key reached the model,
 * so it counts as entitled. 401/403/404 do not.
 */
export function classifyProbeError(err: RigError): EntitlementStatus {
  switch (err.kind) {
    case "auth":
      return "unauthorized";
    case "forbidden":
      return "forbidden";
    case "not_found":
      return "not_found";
    case "rate_limit":
      return "rate_limited";
    case "invalid_request":
      return "entitled";
    case "server":
    case "network":
    case "cancelled":
    case "unknown":
    default:
      return "unknown";
  }
}
