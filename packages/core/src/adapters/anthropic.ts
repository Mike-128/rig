import Anthropic from "@anthropic-ai/sdk";
import type { Block, CanonicalRequest, RigError, Message, Model, StopReason, StreamEvent, Usage } from "../types";
import type { AdapterConnection, ProviderAdapter } from "./types";
import { cancelledError, errorFromStatus, isAbortError, networkError } from "./errors";
import type { ProbeResult } from "../gateway/probe";
import { classifyProbeError } from "../gateway/probe";

function makeClient(conn: AdapterConnection): Anthropic {
  return new Anthropic({
    apiKey: "rig-proxy",
    baseURL: conn.baseUrl,
    defaultHeaders: conn.headers,
    timeout: conn.timeoutMs ?? 10 * 60 * 1000,
    maxRetries: conn.maxRetries ?? 2,
  });
}

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.flatMap((b): Anthropic.ContentBlockParam[] => {
      switch (b.type) {
        case "text":
          return b.text.length ? [{ type: "text", text: b.text }] : [];
        case "image":
          return [{ type: "image", source: { type: "base64", media_type: b.mediaType as "image/png", data: b.data } }];
        case "tool_use":
          return [{ type: "tool_use", id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }];
        case "tool_result":
          return [{ type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false }];
        case "reasoning":
          // Replay the provider-native block verbatim (thinking + signature).
          return b.opaque ? [b.opaque as Anthropic.ContentBlockParam] : [];
      }
    }),
  }));
}

function fromAnthropicContent(content: Anthropic.ContentBlock[]): Block[] {
  const out: Block[] = [];
  for (const c of content) {
    if (c.type === "text") out.push({ type: "text", text: c.text });
    else if (c.type === "tool_use") out.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    else if (c.type === "thinking") out.push({ type: "reasoning", text: c.thinking, opaque: c });
    else if (c.type === "redacted_thinking") out.push({ type: "reasoning", opaque: c });
  }
  return out;
}

function mapStop(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function mapUsage(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

export const anthropicAdapter: ProviderAdapter = {
  dialect: "anthropic.messages",

  async *stream(req: CanonicalRequest, conn: AdapterConnection, model: Model, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const client = makeClient(conn);
    const params: Anthropic.MessageStreamParams = {
      model: conn.modelId,
      max_tokens: req.maxOutputTokens ?? 16000,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.system) params.system = req.system;
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));
      params.tool_choice = req.toolChoice === "none" ? { type: "none" } : { type: "auto" };
    }
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.reasoning?.effort && model.capabilities.reasoning) {
      (params as unknown as { output_config: { effort: string } }).output_config = { effort: req.reasoning.effort };
    }

    yield { type: "message_start" };
    try {
      const stream = client.messages.stream(params, { signal });
      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          if (ev.content_block.type === "tool_use") {
            yield { type: "tool_use_start", id: ev.content_block.id, name: ev.content_block.name };
          }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta;
          if (d.type === "text_delta") yield { type: "text_delta", text: d.text };
          else if (d.type === "thinking_delta") yield { type: "reasoning_delta", text: d.thinking };
          else if (d.type === "input_json_delta") yield { type: "tool_use_delta", id: String(ev.index), partialJson: d.partial_json };
        }
      }
      const final = await stream.finalMessage();
      const content = fromAnthropicContent(final.content);
      for (const b of content) {
        if (b.type === "tool_use") yield { type: "tool_use_end", id: b.id, name: b.name, input: b.input };
      }
      const usage = mapUsage(final.usage);
      yield { type: "usage", usage };
      yield {
        type: "message_end",
        stopReason: mapStop(final.stop_reason),
        message: { role: "assistant", content },
        usage,
      };
    } catch (err) {
      yield { type: "error", error: anthropicAdapter.normalizeError(err) };
    }
  },

  async probe(conn, _model, signal): Promise<ProbeResult> {
    const client = makeClient({ ...conn, maxRetries: 0, timeoutMs: 30_000 });
    const t0 = Date.now();
    try {
      await client.messages.create(
        { model: conn.modelId, max_tokens: 5, messages: [{ role: "user", content: "hi" }] },
        { signal },
      );
      return { status: "entitled", latencyMs: Date.now() - t0 };
    } catch (err) {
      const e = anthropicAdapter.normalizeError(err);
      return { status: classifyProbeError(e), message: e.message, latencyMs: Date.now() - t0 };
    }
  },

  async listModels(conn, signal): Promise<string[]> {
    const client = makeClient({ ...conn, maxRetries: 0, timeoutMs: 30_000 });
    const ids: string[] = [];
    for await (const m of client.models.list({}, { signal })) ids.push(m.id);
    return ids;
  },

  normalizeError(err: unknown): RigError {
    if (isAbortError(err)) return cancelledError();
    if (err instanceof Anthropic.APIConnectionError) return networkError(err.message);
    if (err instanceof Anthropic.APIError) return errorFromStatus(err.status, err.message);
    return { kind: "unknown", message: err instanceof Error ? err.message : String(err), retryable: false };
  },
};
