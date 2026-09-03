/** Tool names an agent definition may reference. Kept separate to avoid a schema/tool import cycle. */
export const AGENT_TOOL_NAMES = [
  "file_read",
  "file_write",
  "web_fetch",
  "shell",
  "load_skill",
  "agent_list",
  "agent_read",
  "agent_write",
  "model_list",
  "skill_list",
  "skill_write",
] as const;

export type BuiltinToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Tools with side effects. Approval-required by default when enabled. */
export const SIDE_EFFECT_TOOLS: readonly BuiltinToolName[] = ["file_write", "shell", "agent_write", "skill_write"];

/** Tools that manage the harness itself rather than the workspace. */
export const MANAGEMENT_TOOLS: readonly BuiltinToolName[] = ["agent_list", "agent_read", "agent_write", "model_list", "skill_list", "skill_write"];
