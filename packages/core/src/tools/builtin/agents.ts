import type { ToolSpec } from "../types";
import { AGENT_TOOL_NAMES } from "../../agent/tool-names";

export const agentListTool: ToolSpec = {
  definition: {
    name: "agent_list",
    description: "List the agents saved in this rig, with their slugs and versions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  sideEffect: false,
  minSandbox: 0,
  needsHost: true,
  async run(_input, ctx) {
    if (!ctx.host) return { output: "Agent management is unavailable in this run", isError: true };
    const agents = ctx.host.listAgents();
    if (!agents.length) return { output: "No agents are saved yet." };
    return { output: agents.map((a) => `${a.slug} (v${a.version}) — ${a.name}${a.description ? `: ${a.description}` : ""}`).join("\n") };
  },
};

export const agentReadTool: ToolSpec = {
  definition: {
    name: "agent_read",
    description: "Read a saved agent's full definition as YAML. Do this before modifying an existing agent so your changes preserve the parts that already work.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "The agent's slug, from agent_list." } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  needsHost: true,
  async run(input, ctx) {
    const { slug } = (input ?? {}) as { slug?: string };
    if (typeof slug !== "string") return { output: "slug is required", isError: true };
    if (!ctx.host) return { output: "Agent management is unavailable in this run", isError: true };
    const yaml = ctx.host.readAgentYaml(slug);
    return yaml ? { output: yaml } : { output: `No agent with slug "${slug}"`, isError: true };
  },
};

export const modelListTool: ToolSpec = {
  definition: {
    name: "model_list",
    description:
      "List the models this rig can reach, with their connection names, entitlement status, and any aliases. Call this before choosing a model for an agent, so you only pick one that actually works.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  sideEffect: false,
  minSandbox: 0,
  needsHost: true,
  async run(_input, ctx) {
    if (!ctx.host) return { output: "Model information is unavailable in this run", isError: true };
    const models = ctx.host.listModels();
    if (!models.length) return { output: "No models are registered. The user needs to add a connection in the Models page first." };
    const lines = models.map((m) => {
      const bits = [`connection: ${m.connection}`, `model: ${m.model}`, `status: ${m.status}`, `dialect: ${m.dialect}`];
      if (m.reasoning) bits.push("supports reasoning effort");
      if (m.aliases.length) bits.push(`aliases: ${m.aliases.join(", ")}`);
      return `- ${bits.join(" · ")}`;
    });
    return {
      output: `${lines.join("\n")}\n\nPrefer binding an agent to an alias (for example {"alias": "default"}) when one exists: aliases resolve per machine, so the agent stays portable. Use an explicit {"connection", "model"} pair only when the agent must run on one specific model.`,
    };
  },
};

const TOOL_ENUM = [...AGENT_TOOL_NAMES];

export const agentWriteTool: ToolSpec = {
  definition: {
    name: "agent_write",
    description:
      "Create a new agent or save a new version of an existing one. The definition is validated before it is written, and errors come back to you so you can correct them and call again. Writing an existing slug creates a new version; the previous version is kept.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable name, e.g. \"Release Notes Writer\"." },
        slug: { type: "string", description: "Lowercase letters, digits, and dashes. Omit to derive it from the name." },
        description: { type: "string", description: "One line describing what the agent does." },
        instructions: {
          type: "string",
          description:
            "The agent's system prompt, written as direct instructions to it. Say what it does, how it should approach the work, and when to use its tools. Be specific rather than generic.",
        },
        model: {
          type: "object",
          description: "Either {\"alias\": \"default\"} or {\"connection\": \"<connection name>\", \"model\": \"<provider model id>\"}, using values from model_list.",
          properties: {
            alias: { type: "string" },
            connection: { type: "string" },
            model: { type: "string" },
          },
          additionalProperties: false,
        },
        tools: {
          type: "array",
          description:
            "Tools the agent may use. file_read and web_fetch are read-only. file_write and shell change things and need sandbox level 1. The agent_* , model_list, and skill_* tools let the agent manage this rig, including creating further agents.",
          items: { type: "string", enum: TOOL_ENUM },
        },
        skills: {
          type: "array",
          description: "Skill names to attach, from skill_list. Their descriptions sit in the agent's context and it loads the full instructions on demand.",
          items: { type: "string" },
        },
        knowledge: { type: "array", description: "Read-only reference folders explicitly supplied by the user. Enable knowledge_read and knowledge_search. Paths refer to the runtime machine, including mounted shares.", items: { type: "object", properties: { name: { type: "string" }, path: { type: "string" }, description: { type: "string" } }, required: ["name", "path"], additionalProperties: false } },
        memory: { type: "boolean", description: "Enable separate persistent notes shared across this agent's sessions. Requires memory_read; optional memory_write requires sandbox 1 and approval." },
        sandbox: { type: "integer", enum: [0, 1], description: "0 is read-only with no process spawn; 1 allows writes and shell inside the workspace. Defaults to 1." },
        approvals: {
          type: "array",
          description: "Tools that must be approved by the user each time before running. Put anything destructive or outward-facing here.",
          items: { type: "string", enum: TOOL_ENUM },
        },
        budget: {
          type: "object",
          properties: {
            maxTurns: { type: "integer", description: "Model turns per run before the agent stops. Default 25." },
            tokens: { type: "integer" },
            usd: { type: "number" },
          },
          additionalProperties: false,
        },
        params: {
          type: "object",
          properties: {
            temperature: { type: "number" },
            maxOutputTokens: { type: "integer" },
            reasoningEffort: { type: "string", enum: ["low", "medium", "high"] },
          },
          additionalProperties: false,
        },
      },
      required: ["name", "instructions", "model"],
      additionalProperties: false,
    },
  },
  sideEffect: true,
  minSandbox: 0,
  needsHost: true,
  async run(input, ctx) {
    if (!ctx.host) return { output: "Agent management is unavailable in this run", isError: true };
    const res = ctx.host.writeAgent(input);
    if (!res.ok) {
      const errors = res.issues.filter((i) => i.severity === "error").map((i) => `- ${i.path ? `${i.path}: ` : ""}${i.message}`);
      return { output: `The definition was rejected. Fix these and call agent_write again:\n${errors.join("\n")}`, isError: true };
    }
    const warnings = res.issues.filter((i) => i.severity === "warning");
    const warnText = warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w.message}`).join("\n")}` : "";
    return {
      output: `Saved agent "${res.slug}" as version ${res.version}. The user can run it from the Chat page by picking it in the agent list, or with: rig agent run ${res.slug} "..."\n\n${res.yaml ?? ""}${warnText}`,
    };
  },
};
