import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolSpec } from "../types";
import { resolveInWorkspace } from "../workspace";

export const fileWriteTool: ToolSpec = {
  definition: {
    name: "file_write",
    description: "Create or overwrite a UTF-8 text file inside the workspace. Parent directories are created. Paths are relative to the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path of the file to write." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  sideEffect: true,
  minSandbox: 1,
  async run(input, ctx) {
    const { path: p, content } = (input ?? {}) as { path?: string; content?: string };
    if (typeof p !== "string" || typeof content !== "string") return { output: "path and content are required", isError: true };
    try {
      const abs = resolveInWorkspace(ctx.workspace, p);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return { output: `Wrote ${content.length} characters to ${p}` };
    } catch (e) {
      return { output: `Cannot write ${p}: ${(e as Error).message}`, isError: true };
    }
  },
};
