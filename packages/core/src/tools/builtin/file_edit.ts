import { readFile, writeFile } from "node:fs/promises";
import type { ToolSpec } from "../types";
import { resolveInWorkspace } from "../workspace";

/**
 * Exact string replacement. Editing by unique match, rather than by line number, survives the
 * file changing between read and edit, and forces the model to quote what it is replacing.
 */
export const fileEditTool: ToolSpec = {
  definition: {
    name: "file_edit",
    description:
      "Edit a file by replacing an exact string. old_string must match the file exactly, including whitespace and indentation (do not include the line-number prefix from file_read), and must be unique unless replace_all is true; include surrounding lines to make it unique. Read the file before editing it. To create a new file, use file_write.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path of the file to edit." },
        old_string: { type: "string", description: "The exact text to replace." },
        new_string: { type: "string", description: "The replacement text. Must differ from old_string." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  sideEffect: true,
  minSandbox: 1,
  async run(input, ctx) {
    const { path: p, old_string: oldStr, new_string: newStr, replace_all: all } = (input ?? {}) as {
      path?: string;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
    };
    if (typeof p !== "string" || typeof oldStr !== "string" || typeof newStr !== "string") {
      return { output: "path, old_string, and new_string are required", isError: true };
    }
    if (!oldStr.length) return { output: "old_string is empty. To create a file, use file_write.", isError: true };
    if (oldStr === newStr) return { output: "old_string and new_string are identical; nothing to change.", isError: true };
    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspace, p);
    } catch (e) {
      return { output: (e as Error).message, isError: true };
    }
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch (e) {
      return { output: `Cannot read ${p}: ${(e as Error).message}`, isError: true };
    }
    // Models emit \n; files on Windows are often \r\n. Match on the file's own line endings.
    const crlf = text.includes("\r\n");
    const find = crlf ? oldStr.replace(/\r?\n/g, "\r\n") : oldStr;
    const repl = crlf ? newStr.replace(/\r?\n/g, "\r\n") : newStr;
    const count = text.split(find).length - 1;
    if (count === 0) return { output: `old_string was not found in ${p}. Re-read the file and copy the text exactly.`, isError: true };
    if (count > 1 && !all) {
      return { output: `old_string occurs ${count} times in ${p}. Add surrounding lines to make it unique, or set replace_all.`, isError: true };
    }
    const updated = all ? text.split(find).join(repl) : text.replace(find, () => repl);
    try {
      await writeFile(abs, updated, "utf8");
    } catch (e) {
      return { output: `Cannot write ${p}: ${(e as Error).message}`, isError: true };
    }
    const line = text.slice(0, text.indexOf(find)).split("\n").length;
    return { output: `Edited ${p}: replaced ${all ? `${count} occurrence${count === 1 ? "" : "s"}` : `1 occurrence at line ${line}`}.` };
  },
};
