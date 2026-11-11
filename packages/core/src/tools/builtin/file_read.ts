import { readFile, stat, readdir } from "node:fs/promises";
import type { ToolSpec } from "../types";
import { resolveInWorkspace } from "../workspace";

const DEFAULT_LINES = 2000;
const MAX_LINE = 2000;

export const fileReadTool: ToolSpec = {
  definition: {
    name: "file_read",
    description:
      "Read a text file, or list a directory, inside the workspace. Paths are relative to the workspace root. Lines come back numbered (number, tab, text) so you can cite and edit them; the numbers are not part of the file. Reads the first 2000 lines unless you pass offset and limit; read long files in ranges.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to a file or directory. Use '.' for the workspace root." },
        offset: { type: "integer", minimum: 1, description: "Line number to start from (1-based)." },
        limit: { type: "integer", minimum: 1, description: "Number of lines to read." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  async run(input, ctx) {
    const { path: p, offset, limit } = (input ?? {}) as { path?: string; offset?: number; limit?: number };
    if (typeof p !== "string") return { output: "path is required", isError: true };
    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspace, p);
    } catch (e) {
      return { output: (e as Error).message, isError: true };
    }
    try {
      const st = await stat(abs);
      if (st.isDirectory()) {
        const entries = await readdir(abs, { withFileTypes: true });
        const lines = entries.map((e) => `${e.isDirectory() ? "d " : "f "}${e.name}`).sort();
        return { output: lines.join("\n") || "(empty directory)" };
      }
      const buf = await readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) return { output: `${p} is a binary file (${st.size} bytes) and was not read.`, isError: true };
      const all = buf.toString("utf8").split(/\r?\n/);
      if (all.length && all[all.length - 1] === "") all.pop();
      if (!all.length) return { output: `${p} is empty.` };
      const start = Math.max(1, offset ?? 1);
      const count = limit ?? DEFAULT_LINES;
      const slice = all.slice(start - 1, start - 1 + count);
      if (!slice.length) return { output: `${p} has ${all.length} lines; offset ${start} is past the end.`, isError: true };
      const width = String(start + slice.length - 1).length;
      const body = slice
        .map((line, i) => `${String(start + i).padStart(width)}\t${line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [line truncated]` : line}`)
        .join("\n");
      const end = start + slice.length - 1;
      const more = end < all.length ? `\n\n[lines ${start}-${end} of ${all.length}; read further with offset ${end + 1}]` : "";
      return { output: body + more };
    } catch (e) {
      return { output: `Cannot read ${p}: ${(e as Error).message}`, isError: true };
    }
  },
};
