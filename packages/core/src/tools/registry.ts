import type { BuiltinToolName } from "../agent/schema";
import { fileReadTool } from "./builtin/file_read";
import { fileWriteTool } from "./builtin/file_write";
import { shellTool } from "./builtin/shell";
import { webFetchTool } from "./builtin/web_fetch";
import type { ToolSpec } from "./types";

export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolSpec> = {
  file_read: fileReadTool,
  file_write: fileWriteTool,
  web_fetch: webFetchTool,
  shell: shellTool,
};

export function toolsFor(names: readonly BuiltinToolName[]): ToolSpec[] {
  return names.map((n) => BUILTIN_TOOLS[n]).filter(Boolean);
}
