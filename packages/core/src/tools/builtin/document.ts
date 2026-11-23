import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import { marked, type Token, type Tokens } from "marked";
import type { ToolSpec } from "../types";
import { resolveInWorkspace } from "../workspace";

/** Where created documents go, relative to the session's workspace. */
export const OUTPUT_DIR = "outputs";

export const DOCUMENT_FORMATS = ["docx", "html", "md", "csv"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

const MAX_CONTENT = 2_000_000;

/** A file name that is safe on Windows, macOS, and Linux, without the extension. */
export function safeBaseName(name: string): string {
  const base = name
    .replace(/\.(docx|html?|md|markdown|csv)$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 100)
    .trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) || !base ? "document" : base;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** outputs/<name>.<ext>, numbered when that name is taken, so nothing is overwritten. */
async function freePath(workspace: string, base: string, ext: string): Promise<{ rel: string; abs: string }> {
  for (let n = 1; ; n++) {
    const rel = `${OUTPUT_DIR}/${n === 1 ? base : `${base} (${n})`}.${ext}`;
    const abs = resolveInWorkspace(workspace, rel);
    if (!(await exists(abs))) return { rel, abs };
  }
}

// ---------------------------------------------------------------- Markdown to Word

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const MONO = "Consolas";

type RunStyle = Pick<IRunOptions, "bold" | "italics" | "strike" | "font" | "style">;

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "");
const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Inline Markdown (bold, italics, code, links) as Word runs. */
function inline(tokens: Token[] | undefined, style: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        out.push(new TextRun({ ...style, text: decode((t as Tokens.Codespan).text), font: MONO }));
        break;
      case "br":
        out.push(new TextRun({ ...style, text: "", break: 1 }));
        break;
      case "link": {
        const l = t as Tokens.Link;
        out.push(new ExternalHyperlink({ link: l.href, children: inline(l.tokens, { ...style, style: "Hyperlink" }) }));
        break;
      }
      case "image":
        out.push(new TextRun({ ...style, text: `[${(t as Tokens.Image).text || "image"}]`, italics: true }));
        break;
      case "html":
        out.push(new TextRun({ ...style, text: decode(stripTags((t as Tokens.HTML).text)) }));
        break;
      case "text": {
        const x = t as Tokens.Text;
        if (x.tokens?.length) out.push(...inline(x.tokens, style));
        else out.push(new TextRun({ ...style, text: decode(x.text) }));
        break;
      }
      default:
        if ("text" in t && typeof t.text === "string") out.push(new TextRun({ ...style, text: decode(stripTags(t.text)) }));
    }
  }
  return out;
}

interface BlockContext {
  /** Numbering instance counter, so each numbered list restarts at 1. */
  lists: { next: number };
  quote: boolean;
}

function paragraph(children: ParagraphChild[], ctx: BlockContext, extra: Partial<ConstructorParameters<typeof Paragraph>[0] & object> = {}): Paragraph {
  return new Paragraph({
    children,
    spacing: { after: 120 },
    ...(ctx.quote ? { indent: { left: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "999999", space: 8 } } } : {}),
    ...extra,
  });
}

function list(t: Tokens.List, ctx: BlockContext, level: number): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const instance = t.ordered ? ctx.lists.next++ : 0;
  for (const item of t.items) {
    let first = true;
    for (const child of item.tokens) {
      if (child.type === "list") {
        out.push(...list(child as Tokens.List, ctx, Math.min(level + 1, 8)));
        continue;
      }
      const text = child as Tokens.Text;
      const runs = child.type === "text" || child.type === "paragraph" ? (text.tokens ? inline(text.tokens) : [new TextRun(decode(text.text))]) : undefined;
      if (runs && first) {
        const prefix = item.task ? [new TextRun({ text: item.checked ? "☑ " : "☐ " })] : [];
        out.push(
          paragraph([...prefix, ...runs], ctx, t.ordered ? { numbering: { reference: "numbers", level, instance } } : { bullet: { level } }),
        );
        first = false;
      } else if (runs) {
        out.push(paragraph(runs, ctx, { indent: { left: 720 * (level + 1) } }));
      } else {
        out.push(...blocks([child], ctx));
      }
    }
  }
  return out;
}

function table(t: Tokens.Table): Table {
  const cell = (c: Tokens.TableCell, header: boolean, align: Tokens.Table["align"][number]) =>
    new TableCell({
      children: [
        new Paragraph({
          children: inline(c.tokens, header ? { bold: true } : {}),
          alignment: align === "center" ? AlignmentType.CENTER : align === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT,
        }),
      ],
      shading: header ? { type: ShadingType.CLEAR, color: "auto", fill: "EDEDED" } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: t.header.map((c, i) => cell(c, true, t.align[i])) }),
      ...t.rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, false, t.align[i])) })),
    ],
  });
}

function blocks(tokens: Token[], ctx: BlockContext): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        out.push(new Paragraph({ heading: HEADINGS[Math.min(h.depth, 6) - 1], children: inline(h.tokens), spacing: { before: 240, after: 120 } }));
        break;
      }
      case "paragraph":
        out.push(paragraph(inline((t as Tokens.Paragraph).tokens), ctx));
        break;
      case "list":
        out.push(...list(t as Tokens.List, ctx, 0));
        break;
      case "table":
        out.push(table(t as Tokens.Table), new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      case "code":
        for (const line of (t as Tokens.Code).text.split("\n")) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: MONO, size: 20 })],
              shading: { type: ShadingType.CLEAR, color: "auto", fill: "F3F3F3" },
              spacing: { after: 0 },
            }),
          );
        }
        out.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      case "blockquote":
        out.push(...blocks((t as Tokens.Blockquote).tokens, { ...ctx, quote: true }));
        break;
      case "hr":
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, spacing: { after: 120 } }));
        break;
      case "html": {
        const text = decode(stripTags((t as Tokens.HTML).text)).trim();
        if (text) out.push(paragraph([new TextRun(text)], ctx));
        break;
      }
      case "space":
        break;
      default:
        if ("text" in t && typeof t.text === "string" && t.text.trim()) out.push(paragraph([new TextRun(decode(stripTags(t.text)))], ctx));
    }
  }
  return out;
}

/** Render Markdown as a Word document. */
export async function markdownToDocx(markdown: string, title: string): Promise<Buffer> {
  const tokens = marked.lexer(markdown, { gfm: true });
  const doc = new Document({
    title,
    creator: "Rig",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [
        {
          reference: "numbers",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: blocks(tokens, { lists: { next: 1 }, quote: false }) }],
  });
  return Packer.toBuffer(doc);
}

/** Render Markdown as a standalone HTML page, or keep a page the model already wrote. */
export function markdownToHtml(content: string, title: string): string {
  if (/^\s*(<!doctype html|<html[\s>])/i.test(content)) return content;
  const body = marked.parse(content, { gfm: true, async: false }) as string;
  const esc = title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc}</title>
<style>
  body { font-family: Calibri, "Segoe UI", system-ui, sans-serif; line-height: 1.5; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.35rem 0.6rem; text-align: left; }
  th { background: #eee; }
  pre { background: #f3f3f3; padding: 0.75rem; overflow-x: auto; }
  code { font-family: Consolas, monospace; }
  blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 1rem; color: #444; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------- the tool

export const documentCreateTool: ToolSpec = {
  definition: {
    name: "document_create",
    description:
      "Create a document file the user can download: a Word document (docx), a web page (html), Markdown (md), or a spreadsheet-ready CSV (csv). " +
      "Write the content as Markdown for docx, html, and md: headings, paragraphs, bold and italics, links, bulleted and numbered lists, tables, code blocks, and quotes all carry over. " +
      "For csv, write the CSV text itself. The file is saved under outputs/ in the workspace and is never overwritten; a taken name gets a number. " +
      "Use this whenever the user asks for a document, report, letter, or file to download, instead of pasting the content and telling them to save it themselves.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name without a folder, for example 'Chicken Parmesan'. The extension is added from the format." },
        format: { type: "string", enum: [...DOCUMENT_FORMATS], description: "docx for Word, html for a web page, md for Markdown, csv for a spreadsheet." },
        content: { type: "string", description: "The document: Markdown for docx, html, and md; CSV text for csv." },
        title: { type: "string", description: "Document title stored in its properties. Defaults to the file name." },
      },
      required: ["filename", "format", "content"],
      additionalProperties: false,
    },
  },
  // It creates files, so plan mode holds it back, but only new files under outputs/: it never
  // changes existing work, so agents limited to reading may still produce deliverables.
  sideEffect: true,
  minSandbox: 0,
  async run(input, ctx) {
    const { filename, format, content, title } = (input ?? {}) as { filename?: unknown; format?: unknown; content?: unknown; title?: unknown };
    if (typeof filename !== "string" || typeof content !== "string") return { output: "filename and content are required", isError: true };
    if (!DOCUMENT_FORMATS.includes(format as DocumentFormat)) return { output: `format must be one of ${DOCUMENT_FORMATS.join(", ")}`, isError: true };
    if (content.length > MAX_CONTENT) return { output: `content is too long (${content.length} characters; the limit is ${MAX_CONTENT})`, isError: true };
    const base = safeBaseName(filename);
    const docTitle = typeof title === "string" && title.trim() ? title.trim() : base;
    try {
      const { rel, abs } = await freePath(ctx.workspace, base, format as string);
      await mkdir(path.dirname(abs), { recursive: true });
      let data: Buffer | string;
      if (format === "docx") data = await markdownToDocx(content, docTitle);
      else if (format === "html") data = markdownToHtml(content, docTitle);
      // A byte-order mark makes Excel read UTF-8 CSV correctly.
      else if (format === "csv") data = content.startsWith("﻿") ? content : `﻿${content}`;
      else data = content;
      await writeFile(abs, data);
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
      return { output: `Created ${rel} (${bytes < 1024 ? `${bytes} bytes` : `${Math.ceil(bytes / 1024)} KB`}). The user can download it from the chat.` };
    } catch (e) {
      return { output: `Cannot create the document: ${(e as Error).message}`, isError: true };
    }
  },
};
