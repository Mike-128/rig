/** Tool names an agent definition may reference. Kept separate to avoid a schema/tool import cycle. */
export const AGENT_TOOL_NAMES = [
  "file_read",
  "file_write",
  "file_edit",
  "glob",
  "grep",
  "shell",
  "web_fetch",
  "todo_write",
  "task",
  "load_skill",
  "agent_list",
  "agent_read",
  "agent_write",
  "model_list",
  "skill_list",
  "skill_write",
] as const;

export type BuiltinToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Tools contributed at runtime by MCP servers are named mcp__<server>__<tool>. */
export const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/;

/** A tool an agent may list: a builtin, or an MCP tool (one tool, or every tool of a server as mcp__<server>__*). */
export type AgentToolName = BuiltinToolName | `mcp__${string}`;

export function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(name) || MCP_TOOL_RE.test(name) || /^mcp__[A-Za-z0-9_-]+__\*$/.test(name);
}

/** Tools with side effects. Approval-required by default when enabled. */
export const SIDE_EFFECT_TOOLS: readonly BuiltinToolName[] = ["file_write", "file_edit", "shell", "agent_write", "skill_write"];

/** Tools that change files in the workspace; "accept edits" mode approves these automatically. */
export const EDIT_TOOLS: readonly BuiltinToolName[] = ["file_write", "file_edit"];

/** Tools that manage the rig itself rather than the workspace. */
export const MANAGEMENT_TOOLS: readonly BuiltinToolName[] = ["agent_list", "agent_read", "agent_write", "model_list", "skill_list", "skill_write"];

/** The tool set of a coding agent, in the order they are offered. */
export const CODING_TOOLS: readonly BuiltinToolName[] = ["file_read", "glob", "grep", "file_edit", "file_write", "shell", "web_fetch", "todo_write", "task", "load_skill"];
