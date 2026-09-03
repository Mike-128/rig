import { readFile, stat, readdir } from "node:fs/promises";
import type { ToolSpec } from "../types";
import { resolveInWorkspace } from "../workspace";

const MAX_CHARS = 60_000;

export const fileReadTool: ToolSpec = {
  definition: {
    name: "file_read",
    description:
      "Read a UTF-8 text file or list a directory inside the workspace. Paths are relative to the workspace root. Large files are truncated.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to a file or directory. Use '.' for the workspace root." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  async run(input, ctx) {
    const { path: p } = (input ?? {}) as { path?: string };
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
      const text = await readFile(abs, "utf8");
      if (text.length > MAX_CHARS) return { output: text.slice(0, MAX_CHARS) + `\n\n[truncated: ${text.length - MAX_CHARS} more characters]` };
      return { output: text };
    } catch (e) {
      return { output: `Cannot read ${p}: ${(e as Error).message}`, isError: true };
    }
  },
};
