import { z } from "zod";
import { AGENT_TOOL_NAMES, MANAGEMENT_TOOLS, SIDE_EFFECT_TOOLS, type BuiltinToolName } from "./tool-names";

export { AGENT_TOOL_NAMES, MANAGEMENT_TOOLS, SIDE_EFFECT_TOOLS };
export type { BuiltinToolName };
/** Back-compat alias for the original name. */
export const BUILTIN_TOOL_NAMES = AGENT_TOOL_NAMES;

export const ModelBindingSchema = z.union([
  z.object({ alias: z.string().min(1) }),
  z.object({ connection: z.string().min(1), model: z.string().min(1) }),
]);
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

export const AgentDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "slug must be lowercase letters, digits, and dashes"),
  description: z.string().max(500).optional(),
  version: z.number().int().positive().default(1),
  engine: z.literal("native").default("native"),
  model: ModelBindingSchema,
  instructions: z.string().min(1),
  tools: z.array(z.enum(AGENT_TOOL_NAMES)).default([]),
  skills: z.array(z.string()).default([]),
  sandbox: z.union([z.literal(0), z.literal(1)]).default(1),
  approvals: z.array(z.enum(AGENT_TOOL_NAMES)).default([]),
  budget: z
    .object({
      maxTurns: z.number().int().positive().max(200).default(25),
      tokens: z.number().int().positive().optional(),
      usd: z.number().positive().optional(),
    })
    .default({ maxTurns: 25 }),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    })
    .default({}),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type AgentDefinitionInput = z.input<typeof AgentDefinitionSchema>;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "agent"
  );
}
