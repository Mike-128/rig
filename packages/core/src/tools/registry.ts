import type { BuiltinToolName } from "../agent/tool-names";
import { fileReadTool } from "./builtin/file_read";
import { fileWriteTool } from "./builtin/file_write";
import { fileEditTool } from "./builtin/file_edit";
import { globTool, grepTool } from "./builtin/search";
import { taskTool, todoWriteTool } from "./builtin/agentic";
import { shellTool } from "./builtin/shell";
import { webFetchTool } from "./builtin/web_fetch";
import { loadSkillTool, skillListTool, skillWriteTool } from "./builtin/skills";
import { agentListTool, agentReadTool, agentWriteTool, modelListTool } from "./builtin/agents";
import type { ToolSpec } from "./types";

export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolSpec> = {
  file_read: fileReadTool,
  file_write: fileWriteTool,
  file_edit: fileEditTool,
  glob: globTool,
  grep: grepTool,
  shell: shellTool,
  web_fetch: webFetchTool,
  todo_write: todoWriteTool,
  task: taskTool,
  load_skill: loadSkillTool,
  agent_list: agentListTool,
  agent_read: agentReadTool,
  agent_write: agentWriteTool,
  model_list: modelListTool,
  skill_list: skillListTool,
  skill_write: skillWriteTool,
};

/**
 * Resolve an agent's tool list. Builtins come from this table; mcp__ names are looked up in the
 * extra tools the runtime supplies (MCP servers), where mcp__<server>__* takes all of a server's tools.
 */
export function toolsFor(names: readonly string[], extra: ToolSpec[] = []): ToolSpec[] {
  const out: ToolSpec[] = [];
  const seen = new Set<string>();
  const add = (t: ToolSpec | undefined) => {
    if (t && !seen.has(t.definition.name)) {
      seen.add(t.definition.name);
      out.push(t);
    }
  };
  for (const n of names) {
    if (n.endsWith("__*")) {
      const prefix = n.slice(0, -1);
      for (const t of extra) if (t.definition.name.startsWith(prefix)) add(t);
    } else {
      add(BUILTIN_TOOLS[n as BuiltinToolName] ?? extra.find((t) => t.definition.name === n));
    }
  }
  return out;
}
