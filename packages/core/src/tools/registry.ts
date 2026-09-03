import type { BuiltinToolName } from "../agent/tool-names";
import { fileReadTool } from "./builtin/file_read";
import { fileWriteTool } from "./builtin/file_write";
import { shellTool } from "./builtin/shell";
import { webFetchTool } from "./builtin/web_fetch";
import { loadSkillTool, skillListTool, skillWriteTool } from "./builtin/skills";
import { agentListTool, agentReadTool, agentWriteTool, modelListTool } from "./builtin/agents";
import type { ToolSpec } from "./types";

export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolSpec> = {
  file_read: fileReadTool,
  file_write: fileWriteTool,
  web_fetch: webFetchTool,
  shell: shellTool,
  load_skill: loadSkillTool,
  agent_list: agentListTool,
  agent_read: agentReadTool,
  agent_write: agentWriteTool,
  model_list: modelListTool,
  skill_list: skillListTool,
  skill_write: skillWriteTool,
};

export function toolsFor(names: readonly BuiltinToolName[]): ToolSpec[] {
  return names.map((n) => BUILTIN_TOOLS[n]).filter(Boolean);
}
