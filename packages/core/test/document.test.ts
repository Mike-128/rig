import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { asPlainTranscript } from "../src/engine/context";
import { probeShapeProblem } from "../src/gateway/probe";
import { documentCreateTool, markdownToDocx, markdownToHtml, safeBaseName } from "../src/tools/builtin/document";
import type { Message } from "../src/types";

/** One file out of a zip, found through the central directory (sizes there are always right). */
function unzipEntry(zip: Buffer, name: string): string {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString("utf8", at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    at += 46 + nameLen + extra + comment;
  }
  throw new Error(`${name} is not in the zip`);
}

const RECIPE = [
  "# Chicken Parmesan",
  "",
  "**Serves 4.** From *the test kitchen*, see [the source](https://example.com/recipe).",
  "",
  "## Ingredients",
  "",
  "- 2 chicken breasts",
  "- 1 cup marinara",
  "  - homemade if you can",
  "",
  "## Steps",
  "",
  "1. Bread the chicken.",
  "2. Bake until golden.",
  "",
  "| Item | Amount |",
  "|---|---|",
  "| Mozzarella | 1 cup |",
  "",
  "> Rest it five minutes.",
  "",
  "```",
  "oven = 425F",
  "```",
].join("\n");

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("documents", () => {
  it("renders Markdown as a real Word document", async () => {
    const docx = await markdownToDocx(RECIPE, "Chicken Parmesan");
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    const xml = unzipEntry(docx, "word/document.xml");
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain("Chicken Parmesan");
    expect(xml).toMatch(/<w:b\/>.*Serves 4\./s);
    expect(xml).toMatch(/<w:i\/>.*the test kitchen/s);
    expect(xml).toContain("<w:numPr>");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("Mozzarella");
    expect(xml).toContain("oven = 425F");
    expect(xml).toContain("<w:hyperlink");
    expect(unzipEntry(docx, "word/_rels/document.xml.rels")).toContain("https://example.com/recipe");
    expect(unzipEntry(docx, "docProps/core.xml")).toContain("<dc:title>Chicken Parmesan</dc:title>");
  });

  it("renders Markdown as a standalone web page, and keeps a page that is already HTML", () => {
    const html = markdownToHtml(RECIPE, "Recipe <1>");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>Recipe &lt;1&gt;</title>");
    expect(html).toContain("<table>");
    const page = "<!doctype html><html><body>mine</body></html>";
    expect(markdownToHtml(page, "x")).toBe(page);
  });

  it("makes file names safe everywhere", () => {
    expect(safeBaseName("Q3: report/final?.docx")).toBe("Q3 report final");
    expect(safeBaseName("..\\..\\evil")).toBe("evil");
    expect(safeBaseName("CON")).toBe("document");
    expect(safeBaseName("   ")).toBe("document");
  });

  it("saves under outputs/ and never overwrites", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "rig-docs-"));
    dirs.push(workspace);
    const ctx = { workspace } as Parameters<typeof documentCreateTool.run>[1];
    const first = await documentCreateTool.run({ filename: "Notes", format: "md", content: "# One" }, ctx);
    const second = await documentCreateTool.run({ filename: "Notes", format: "md", content: "# Two" }, ctx);
    expect(first.output).toMatch(/^Created outputs\/Notes\.md \(/);
    expect(second.output).toMatch(/^Created outputs\/Notes \(2\)\.md \(/);
    expect(readFileSync(path.join(workspace, "outputs", "Notes.md"), "utf8")).toBe("# One");
    const csv = await documentCreateTool.run({ filename: "Table", format: "csv", content: "a,b\n1,2\n" }, ctx);
    expect(csv.isError).toBeUndefined();
    expect(readFileSync(path.join(workspace, "outputs", "Table.csv"), "utf8")).toBe("﻿a,b\n1,2\n");
    expect((await documentCreateTool.run({ filename: "x", format: "pdf", content: "x" }, ctx)).isError).toBe(true);
  });
});

describe("probe answers", () => {
  it("notices a successful answer in the other dialect's format", () => {
    expect(probeShapeProblem("openai.chat", { choices: [] })).toBeUndefined();
    expect(probeShapeProblem("anthropic.messages", { type: "message", content: [] })).toBeUndefined();
    expect(probeShapeProblem("openai.chat", { type: "message", content: [] })).toMatch(/OpenAI Chat Completions format/);
    expect(probeShapeProblem("anthropic.messages", { choices: [] })).toMatch(/Anthropic Messages format/);
  });
});

describe("compaction transcript", () => {
  it("turns tool calls and results into text so the request needs no tools", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read it" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Reading." }, { type: "tool_use", id: "t1", name: "file_read", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "hello", isError: false }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];
    const plain = asPlainTranscript(messages);
    expect(plain.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(plain.flatMap((m) => m.content).every((b) => b.type === "text")).toBe(true);
    expect(JSON.stringify(plain)).toContain('[Called file_read with {\\"path\\":\\"a.txt\\"}]');
    expect(JSON.stringify(plain)).toContain("[Result of that call: hello]");
  });
});
