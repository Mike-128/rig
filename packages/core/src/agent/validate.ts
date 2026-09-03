import { AgentDefinitionSchema, SIDE_EFFECT_TOOLS, type AgentDefinition, type AgentDefinitionInput } from "./schema";

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  definition?: AgentDefinition;
  issues: ValidationIssue[];
}

/**
 * Structural validation plus the native engine's `supports()` rules.
 * Warnings do not block saving; errors do.
 */
export function validateAgentDefinition(input: unknown): ValidationResult {
  const parsed = AgentDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        severity: "error" as const,
      })),
    };
  }
  const def = parsed.data;
  const issues: ValidationIssue[] = [];

  // approvals must reference enabled tools
  for (const t of def.approvals) {
    if (!def.tools.includes(t)) {
      issues.push({ path: "approvals", message: `"${t}" is in approvals but not in tools`, severity: "error" });
    }
  }

  // sandbox 0 forbids process spawn and writes
  if (def.sandbox === 0) {
    for (const t of def.tools) {
      if (SIDE_EFFECT_TOOLS.includes(t)) {
        issues.push({ path: "tools", message: `"${t}" requires sandbox level 1 or higher`, severity: "error" });
      }
    }
  }

  // side-effect tools without approval: allowed, but warn
  for (const t of def.tools) {
    if (SIDE_EFFECT_TOOLS.includes(t) && !def.approvals.includes(t)) {
      issues.push({
        path: "approvals",
        message: `"${t}" has side effects and will run without approval`,
        severity: "warning",
      });
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), definition: def, issues };
}

export function defaultAgentInput(name: string, slug: string): AgentDefinitionInput {
  return {
    name,
    slug,
    model: { alias: "default" },
    instructions: "You are a helpful assistant.",
    tools: ["web_fetch", "file_read"],
    sandbox: 1,
    approvals: [],
  };
}
