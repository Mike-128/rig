import type { AgentDefinition } from "../agent/schema";
import type { SkillSummary } from "../skills/types";

export interface PromptContext {
  workspace?: string;
  skills?: SkillSummary[];
}

/**
 * Compose the system prompt: the agent's own instructions first (the stable prefix),
 * then the skill catalog, then a short environment note.
 */
export function buildSystemPrompt(agent: AgentDefinition, ctx: PromptContext = {}): string {
  const parts = [agent.instructions.trim()];

  const skills = (ctx.skills ?? []).filter((s) => agent.skills.includes(s.name));
  if (skills.length) {
    const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    parts.push(
      `## Available skills\n\nThese skills hold detailed instructions for specific kinds of work. Only the names and descriptions are shown here. When a task matches one, call load_skill with its name to read the full instructions before you start, and follow them.\n\n${lines}`,
    );
  }

  const env: string[] = [];
  if (ctx.workspace) env.push(`Workspace directory: ${ctx.workspace}. File paths you pass to tools are relative to it, and you cannot read or write outside it.`);
  if (agent.sandbox === 0) env.push("You are running read-only: you cannot write files or run commands.");
  if (env.length) parts.push(`## Environment\n\n${env.join("\n")}`);

  return parts.join("\n\n");
}
