import type { ToolSpec } from "../types";

/**
 * Progressive disclosure: skill names and descriptions sit in the system prompt;
 * the full body is loaded only when the model asks for it.
 */
export const loadSkillTool: ToolSpec = {
  definition: {
    name: "load_skill",
    description:
      "Load the full instructions for one of your available skills, or read a resource file bundled with it. Call this when a task matches a skill's description, before doing the work.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name, exactly as listed in your available skills." },
        file: { type: "string", description: "Optional: a resource file bundled with the skill, as listed when you load it." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  needsHost: true,
  async run(input, ctx) {
    const { name, file } = (input ?? {}) as { name?: string; file?: string };
    if (typeof name !== "string") return { output: "name is required", isError: true };
    if (!ctx.host) return { output: "Skills are unavailable in this run", isError: true };
    if (ctx.enabledSkills && !ctx.enabledSkills.includes(name)) {
      return { output: `Skill "${name}" is not enabled for this agent. Enabled: ${ctx.enabledSkills.join(", ") || "none"}`, isError: true };
    }
    const skill = ctx.host.readSkill(name);
    if (!skill) return { output: `No skill named "${name}"`, isError: true };

    if (file) {
      const content = ctx.host.readSkillFile(name, file);
      if (content === undefined) return { output: `Skill "${name}" has no file "${file}". Available: ${skill.files.join(", ") || "none"}`, isError: true };
      return { output: content };
    }

    const resources = skill.files.length
      ? `\n\n---\nResource files bundled with this skill (read one by calling load_skill again with the file argument):\n${skill.files.map((f) => `- ${f}`).join("\n")}`
      : "";
    return { output: `# Skill: ${skill.name}\n${skill.description}\n\n${skill.body}${resources}` };
  },
};

export const skillListTool: ToolSpec = {
  definition: {
    name: "skill_list",
    description: "List every skill installed in this harness, including ones not enabled for you. Use it when choosing skills to attach to an agent you are creating.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  sideEffect: false,
  minSandbox: 0,
  needsHost: true,
  async run(_input, ctx) {
    if (!ctx.host) return { output: "Skill management is unavailable in this run", isError: true };
    const skills = ctx.host.listSkills();
    if (!skills.length) return { output: "No skills are installed." };
    return { output: skills.map((s) => `${s.name} (${s.source})\n  ${s.description}`).join("\n") };
  },
};

export const skillWriteTool: ToolSpec = {
  definition: {
    name: "skill_write",
    description:
      "Create or replace a skill: reusable instructions for a kind of task, which any agent can be given. Write the body as direct instructions to whoever performs the task. The description matters most: it is the only part always in context, and it decides when the skill gets loaded.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase letters, digits, and dashes, e.g. \"release-notes\"." },
        description: { type: "string", description: "One or two sentences saying what the skill covers and when to use it." },
        body: { type: "string", description: "Markdown instructions for performing the task." },
      },
      required: ["name", "description", "body"],
      additionalProperties: false,
    },
  },
  sideEffect: true,
  minSandbox: 0,
  needsHost: true,
  async run(input, ctx) {
    const { name, description, body } = (input ?? {}) as { name?: string; description?: string; body?: string };
    if (typeof name !== "string" || typeof description !== "string" || typeof body !== "string") {
      return { output: "name, description, and body are required", isError: true };
    }
    if (!ctx.host) return { output: "Skill management is unavailable in this run", isError: true };
    const res = ctx.host.writeSkill(name, description, body);
    if (!res.ok) return { output: res.error ?? "could not write the skill", isError: true };
    return { output: `Saved skill "${name}" (${res.hash}). Attach it to an agent with the skills field.` };
  },
};
