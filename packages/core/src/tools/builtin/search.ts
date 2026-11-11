import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolSpec } from "../types";
import { walkFiles } from "../walk";
import { resolveInWorkspace } from "../workspace";

const GLOB_LIMIT = 250;
const MAX_FILE_BYTES = 2_000_000;
const MAX_OUTPUT = 30_000;

export const globTool: ToolSpec = {
  definition: {
    name: "glob",
    description:
      "Find files by name pattern, newest first. Patterns are globs relative to the search directory: \"**/*.ts\" for every TypeScript file, \"src/**/test_*.py\", \"*.json\" for the top level only. Skips .git, node_modules, and .gitignored paths.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. \"**/*.tsx\"." },
        path: { type: "string", description: "Directory to search, relative to the workspace. Defaults to the workspace root." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  async run(input, ctx) {
    const { pattern, path: p } = (input ?? {}) as { pattern?: string; path?: string };
    if (typeof pattern !== "string" || !pattern) return { output: "pattern is required", isError: true };
    let dir: string;
    try {
      dir = resolveInWorkspace(ctx.workspace, p ?? ".");
    } catch (e) {
      return { output: (e as Error).message, isError: true };
    }
    const hits: { rel: string; mtime: number }[] = [];
    for await (const f of walkFiles(ctx.workspace, dir, ctx.signal)) {
      if (!path.posix.matchesGlob(f.rel, pattern)) continue;
      const st = await stat(f.abs).catch(() => undefined);
      hits.push({ rel: f.rel, mtime: st?.mtimeMs ?? 0 });
    }
    if (!hits.length) return { output: `No files match ${pattern}.` };
    hits.sort((a, b) => b.mtime - a.mtime);
    const prefix = p && p !== "." ? `${p.replace(/[\\/]+$/, "")}/` : "";
    const shown = hits.slice(0, GLOB_LIMIT).map((h) => prefix + h.rel);
    return { output: shown.join("\n") + (hits.length > GLOB_LIMIT ? `\n\n[${hits.length - GLOB_LIMIT} more; narrow the pattern]` : "") };
  },
};

type Mode = "files_with_matches" | "content" | "count";

export const grepTool: ToolSpec = {
  definition: {
    name: "grep",
    description:
      "Search file contents with a regular expression (JavaScript syntax). Default output lists matching files; use output_mode \"content\" for matching lines with line numbers (optionally with context lines), or \"count\" for match counts. Filter files with glob, e.g. \"**/*.ts\". Skips binary files, .git, node_modules, and .gitignored paths.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "File or directory to search, relative to the workspace. Defaults to the root." },
        glob: { type: "string", description: "Only search files matching this glob, relative to path." },
        output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
        ignore_case: { type: "boolean" },
        context: { type: "integer", minimum: 0, maximum: 20, description: "Lines of context around each match (content mode)." },
        head_limit: { type: "integer", minimum: 1, description: "Return at most this many output lines or files." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  async run(input, ctx) {
    const o = (input ?? {}) as { pattern?: string; path?: string; glob?: string; output_mode?: Mode; ignore_case?: boolean; context?: number; head_limit?: number };
    if (typeof o.pattern !== "string" || !o.pattern) return { output: "pattern is required", isError: true };
    let re: RegExp;
    try {
      re = new RegExp(o.pattern, o.ignore_case ? "i" : "");
    } catch (e) {
      return { output: `Invalid regular expression: ${(e as Error).message}`, isError: true };
    }
    let target: string;
    try {
      target = resolveInWorkspace(ctx.workspace, o.path ?? ".");
    } catch (e) {
      return { output: (e as Error).message, isError: true };
    }
    const mode: Mode = o.output_mode ?? "files_with_matches";
    const ctxLines = mode === "content" ? (o.context ?? 0) : 0;
    const limit = o.head_limit ?? (mode === "content" ? 400 : 200);
    const st = await stat(target).catch(() => undefined);
    if (!st) return { output: `${o.path} does not exist.`, isError: true };

    const files: { abs: string; shown: string }[] = [];
    const base = path.relative(ctx.workspace, st.isDirectory() ? target : path.dirname(target)).split(path.sep).join("/");
    const show = (rel: string) => (base ? `${base}/${rel}` : rel);
    if (st.isFile()) files.push({ abs: target, shown: path.relative(ctx.workspace, target).split(path.sep).join("/") });
    else {
      for await (const f of walkFiles(ctx.workspace, target, ctx.signal)) {
        if (o.glob && !path.posix.matchesGlob(f.rel, o.glob) && !path.posix.matchesGlob(path.posix.basename(f.rel), o.glob)) continue;
        files.push({ abs: f.abs, shown: show(f.rel) });
      }
    }

    const out: string[] = [];
    let matchedFiles = 0;
    for (const f of files) {
      if (ctx.signal.aborted || out.length >= limit) break;
      const text = await readText(f.abs);
      if (text === undefined) continue;
      const lines = text.split(/\r?\n/);
      const hits: number[] = [];
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i);
      if (!hits.length) continue;
      matchedFiles++;
      if (mode === "files_with_matches") out.push(f.shown);
      else if (mode === "count") out.push(`${f.shown}:${hits.length}`);
      else {
        let last = -1;
        for (const h of hits) {
          const from = Math.max(h - ctxLines, last + 1);
          const to = Math.min(h + ctxLines, lines.length - 1);
          if (last >= 0 && from > last + 1) out.push("--");
          for (let i = from; i <= to; i++) out.push(`${f.shown}:${i + 1}${i === h ? ":" : "-"}${lines[i].slice(0, 500)}`);
          last = to;
          if (out.length >= limit) break;
        }
      }
    }
    if (!out.length) return { output: `No matches for /${o.pattern}/.` };
    let body = out.slice(0, limit).join("\n");
    if (body.length > MAX_OUTPUT) body = `${body.slice(0, MAX_OUTPUT)}\n[output truncated]`;
    const note = out.length >= limit ? `\n\n[stopped at ${limit} lines; narrow the search or raise head_limit]` : mode === "files_with_matches" ? `\n\n[${matchedFiles} file(s)]` : "";
    return { output: body + note };
  },
};

async function readText(abs: string): Promise<string | undefined> {
  const fh = await open(abs, "r").catch(() => undefined);
  if (!fh) return undefined;
  try {
    const { size } = await fh.stat();
    if (size > MAX_FILE_BYTES) return undefined;
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    if (buf.subarray(0, 8000).includes(0)) return undefined;
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}
