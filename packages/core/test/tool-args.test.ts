import { describe, expect, it } from "vitest";
import { errorFromStatus, parseToolArguments } from "../src";

describe("tool argument parsing", () => {
  it("parses the ordinary case of concatenated partial fragments", () => {
    expect(parseToolArguments('{"path":"hello.txt"}')).toEqual({ path: "hello.txt" });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
    expect(parseToolArguments("{}")).toEqual({});
  });

  it("recovers the arguments when a provider streams several complete objects", () => {
    // Gemini's OpenAI-compatible endpoint emits empty placeholders before the real arguments,
    // which concatenate into invalid JSON. This exact string failed every load_skill call.
    expect(parseToolArguments('{}{}{"name":"agent-design"}')).toEqual({ name: "agent-design" });
    expect(parseToolArguments('{}{"name":"x"}{}')).toEqual({ name: "x" });
  });

  it("merges successive objects, with later fragments winning", () => {
    expect(parseToolArguments('{"a":1}{"b":2}')).toEqual({ a: 1, b: 2 });
    expect(parseToolArguments('{"a":1}{"a":2}')).toEqual({ a: 2 });
  });

  it("is not confused by braces inside strings", () => {
    expect(parseToolArguments('{"command":"echo \\"}{\\" > f"}')).toEqual({ command: 'echo "}{" > f' });
    expect(parseToolArguments('{}{"body":"a } b { c"}')).toEqual({ body: "a } b { c" });
  });

  it("keeps nested structures intact", () => {
    expect(parseToolArguments('{}{"model":{"alias":"default"},"tools":["file_read"]}')).toEqual({
      model: { alias: "default" },
      tools: ["file_read"],
    });
  });

  it("surfaces the raw string when nothing parses, rather than throwing", () => {
    expect(parseToolArguments("not json at all")).toEqual({ _raw: "not json at all" });
    expect(parseToolArguments('{"unterminated": ')).toEqual({ _raw: '{"unterminated": ' });
  });
});

describe("error messages", () => {
  it("replaces a bare status line with something a user can act on", () => {
    const e = errorFromStatus(429, "429 status code (no body)");
    expect(e.kind).toBe("rate_limit");
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/Rate limited/);
    expect(e.message).not.toMatch(/no body\)/);
    expect(errorFromStatus(401, "401 status code (no body)").message).toMatch(/rejected the key/);
    expect(errorFromStatus(503, "503 status code (no body)").message).toMatch(/transient/);
  });

  it("keeps a real provider message untouched", () => {
    const detail = "The model 'gemini-9' does not exist";
    expect(errorFromStatus(404, detail).message).toBe(detail);
  });
});
