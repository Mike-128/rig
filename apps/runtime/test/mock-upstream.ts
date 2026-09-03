import http from "node:http";

/**
 * A tiny upstream that speaks both dialects, for end-to-end tests without real keys.
 *
 * Auth: x-api-key or Authorization: Bearer must equal GOOD_KEY.
 * Models: "mock-claude" (Anthropic dialect), "mock-gpt" (OpenAI dialect). Others -> 404.
 * Behavior: the mock picks a tool from the user's text and the offered tools (see chooseTool):
 * "read" -> file_read, "skill" -> load_skill, "build"/"create an agent" -> agent_write.
 * After a tool result it replies with the result content.
 */
export const GOOD_KEY = "good-key";

interface Started {
  port: number;
  url: string;
  requests: { path: string; body: unknown; headers: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
  });

function authOk(req: http.IncomingMessage): boolean {
  const key = req.headers["x-api-key"];
  const bearer = req.headers.authorization;
  return key === GOOD_KEY || bearer === `Bearer ${GOOD_KEY}`;
}

function lastUserText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (t) return t;
    }
  }
  return "";
}

interface ToolPlan {
  name: string;
  args: Record<string, unknown>;
}

/** Decide which tool the mock "model" calls, from the user's text and the offered tools. */
export function chooseTool(messages: { role: string; content: unknown }[], tools: unknown): ToolPlan | undefined {
  const names = new Set(
    (Array.isArray(tools) ? tools : []).map((t) => {
      const o = t as { name?: string; function?: { name?: string } };
      return o.name ?? o.function?.name ?? "";
    }),
  );
  const text = lastUserText(messages);
  if (names.has("agent_write") && /build|create an agent/i.test(text)) {
    return {
      name: "agent_write",
      args: {
        name: "Note Taker",
        description: "Writes meeting notes.",
        instructions: "You write concise meeting notes from transcripts the user provides.",
        model: { alias: "default" },
        tools: ["file_read"],
        sandbox: 0,
      },
    };
  }
  if (names.has("load_skill") && /skill/i.test(text)) return { name: "load_skill", args: { name: "agent-design" } };
  if (names.has("file_read") && /read/i.test(text)) return { name: "file_read", args: { path: "hello.txt" } };
  return undefined;
}

function anthropicToolResult(messages: { role: string; content: unknown }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (Array.isArray(c)) {
      const r = c.find((b) => b.type === "tool_result");
      if (r) return typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    }
  }
  return undefined;
}

function openaiToolResult(messages: { role: string; content: unknown }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "tool") return String(messages[i].content);
  return undefined;
}

export function startMockUpstream(): Promise<Started> {
  const requests: Started["requests"] = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* ignore */
    }
    requests.push({ path: req.url ?? "", body, headers: req.headers });
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (!authOk(req)) {
      if (req.url?.startsWith("/v1/messages")) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      return json(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      return json(200, { data: [{ id: "mock-gpt", object: "model" }, { id: "mock-gpt-extra", object: "model" }, { id: "embed-x", object: "model" }, { id: "mock-claude", display_name: "Mock Claude" }], object: "list" });
    }

    const model = String(body.model ?? "");
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

    // ---------------- Anthropic dialect ----------------
    if (req.url === "/v1/messages" && req.method === "POST") {
      if (model !== "mock-claude") return json(404, { type: "error", error: { type: "not_found_error", message: `model: ${model}` } });
      const prior = anthropicToolResult(messages);
      const plan = hasTools && !prior ? chooseTool(messages, body.tools) : undefined;
      const text = prior ? `The file says: ${prior}` : `You said: ${lastUserText(messages)}`;
      if (!body.stream) {
        return json(200, { id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } });
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
      if (plan) {
        const argsJson = JSON.stringify(plan.args);
        const half = Math.ceil(argsJson.length / 2);
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Calling ${plan.name}.` } });
        ev("content_block_stop", { type: "content_block_stop", index: 0 });
        ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: plan.name, input: {} } });
        ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: argsJson.slice(0, half) } });
        ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: argsJson.slice(half) } });
        ev("content_block_stop", { type: "content_block_stop", index: 1 });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } });
      } else {
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        for (const piece of text.match(/.{1,6}/g) ?? []) ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
        ev("content_block_stop", { type: "content_block_stop", index: 0 });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } });
      }
      ev("message_stop", { type: "message_stop" });
      return res.end();
    }

    // ---------------- OpenAI dialect ----------------
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      if (model !== "mock-gpt" && model !== "mock-gpt-extra") return json(404, { error: { message: `The model '${model}' does not exist`, type: "invalid_request_error", code: "model_not_found" } });
      const prior = openaiToolResult(messages);
      const plan = hasTools && !prior ? chooseTool(messages, body.tools) : undefined;
      const text = prior ? `The file says: ${prior}` : `You said: ${lastUserText(messages)}`;
      if (!body.stream) {
        return json(200, { id: "chatcmpl-1", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices, ...extra })}\n\n`);
      if (plan) {
        const argsJson = JSON.stringify(plan.args);
        const half = Math.ceil(argsJson.length / 2);
        chunk([{ index: 0, delta: { role: "assistant", content: `Calling ${plan.name}.` }, finish_reason: null }]);
        chunk([
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", extra_content: { google: { thought_signature: "sig-abc" } }, function: { name: plan.name, arguments: "" } }] },
            finish_reason: null,
          },
        ]);
        chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, half) } }] }, finish_reason: null }]);
        chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(half) } }] }, finish_reason: null }]);
        chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
      } else {
        chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
        for (const piece of text.match(/.{1,6}/g) ?? []) chunk([{ index: 0, delta: { content: piece }, finish_reason: null }]);
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
      }
      chunk([], { usage: { prompt_tokens: 11, completion_tokens: 8, total_tokens: 19 } });
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    json(404, { error: { message: `no route ${req.method} ${req.url}` } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
