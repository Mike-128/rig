import OpenAI from "openai";
import type { Block, CanonicalRequest, RigError, Message, Model, StopReason, StreamEvent, Usage } from "../types";
import type { AdapterConnection, ProviderAdapter } from "./types";
import { cancelledError, errorFromStatus, isAbortError, networkError } from "./errors";
import type { ProbeResult } from "../gateway/probe";
import { classifyProbeError } from "../gateway/probe";
import { parseToolArguments } from "./tool-args";

function makeClient(conn: AdapterConnection): OpenAI {
  return new OpenAI({
    apiKey: "rig-proxy",
    baseURL: conn.baseUrl,
    defaultHeaders: conn.headers,
    timeout: conn.timeoutMs ?? 10 * 60 * 1000,
    maxRetries: conn.maxRetries ?? 2,
  });
}

function toOpenAIMessages(system: string | undefined, messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      const results = m.content.filter((b) => b.type === "tool_result");
      for (const r of results) {
        if (r.type === "tool_result") out.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
      }
      const parts: OpenAI.ChatCompletionContentPart[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text.length) parts.push({ type: "text", text: b.text });
        else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
      }
      if (parts.length) {
        const allText = parts.every((p) => p.type === "text");
        out.push({ role: "user", content: allText ? parts.map((p) => (p as { text: string }).text).join("") : parts });
      }
    } else {
      const text = m.content
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = m.content
        .filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => {
          const call: Record<string, unknown> = {
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          };
          // Replayed verbatim: Gemini 3 rejects a tool call whose thought_signature is missing.
          if (b.providerMeta !== undefined) call.extra_content = b.providerMeta;
          return call as unknown as OpenAI.ChatCompletionMessageToolCall;
        });
      const msg: OpenAI.ChatCompletionAssistantMessageParam = { role: "assistant", content: text.length ? text : null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

function mapFinish(reason: string | null | undefined, hadToolCalls: boolean): StopReason {
  if (hadToolCalls) return "tool_use";
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return reason ? "other" : "end_turn";
  }
}

function mapUsage(u: OpenAI.CompletionUsage | null | undefined): Usage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cachedInputTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  };
}

export const openaiAdapter: ProviderAdapter = {
  dialect: "openai.chat",

  async *stream(req: CanonicalRequest, conn: AdapterConnection, model: Model, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const client = makeClient(conn);
    const maxField = model.params?.maxTokensField ?? "max_tokens";
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: conn.modelId,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
    };
    if (model.params?.streamUsage !== false) params.stream_options = { include_usage: true };
    if (req.maxOutputTokens) (params as unknown as Record<string, unknown>)[maxField] = req.maxOutputTokens;
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      params.tool_choice = req.toolChoice === "none" ? "none" : "auto";
    }
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.reasoning?.effort && model.capabilities.reasoning) params.reasoning_effort = req.reasoning.effort;

    yield { type: "message_start" };
    try {
      const stream = await client.chat.completions.create(params, { signal });
      let text = "";
      const calls = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();
      let finish: string | null | undefined;
      let usage: Usage | undefined;
      for await (const chunk of stream) {
        if (chunk.usage) usage = mapUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          let cur = calls.get(idx);
          const extra = (tc as unknown as { extra_content?: unknown }).extra_content;
          if (!cur) {
            cur = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? "", args: "", extra };
            calls.set(idx, cur);
            yield { type: "tool_use_start", id: cur.id, name: cur.name };
          } else {
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (extra !== undefined) cur.extra = extra;
          }
          if (tc.function?.arguments) {
            cur.args += tc.function.arguments;
            yield { type: "tool_use_delta", id: cur.id, partialJson: tc.function.arguments };
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const content: Block[] = [];
      if (text.length) content.push({ type: "text", text });
      for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
        const input = parseToolArguments(c.args);
        content.push({ type: "tool_use", id: c.id, name: c.name, input, ...(c.extra !== undefined ? { providerMeta: c.extra } : {}) });
        yield { type: "tool_use_end", id: c.id, name: c.name, input };
      }
      const u = usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
      yield { type: "usage", usage: u };
      yield {
        type: "message_end",
        stopReason: mapFinish(finish, calls.size > 0),
        message: { role: "assistant", content },
        usage: u,
      };
    } catch (err) {
      yield { type: "error", error: openaiAdapter.normalizeError(err) };
    }
  },

  async probe(conn, model, signal): Promise<ProbeResult> {
    const client = makeClient({ ...conn, maxRetries: 0, timeoutMs: 30_000 });
    const maxField = model.params?.maxTokensField ?? "max_tokens";
    const t0 = Date.now();
    try {
      const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
        model: conn.modelId,
        messages: [{ role: "user", content: "hi" }],
      };
      (params as unknown as Record<string, unknown>)[maxField] = 5;
      await client.chat.completions.create(params, { signal });
      return { status: "entitled", latencyMs: Date.now() - t0 };
    } catch (err) {
      const e = openaiAdapter.normalizeError(err);
      return { status: classifyProbeError(e), message: e.message, latencyMs: Date.now() - t0 };
    }
  },

  async listModels(conn, signal): Promise<string[]> {
    const client = makeClient({ ...conn, maxRetries: 0, timeoutMs: 30_000 });
    const ids: string[] = [];
    for await (const m of client.models.list({ signal })) ids.push(m.id);
    return ids;
  },

  normalizeError(err: unknown): RigError {
    if (isAbortError(err)) return cancelledError();
    if (err instanceof OpenAI.APIConnectionError) return networkError(err.message);
    if (err instanceof OpenAI.APIError) return errorFromStatus(err.status, err.message);
    return { kind: "unknown", message: err instanceof Error ? err.message : String(err), retryable: false };
  },
};
