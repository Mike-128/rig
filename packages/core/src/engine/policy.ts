import type { AgentDefinition } from "../agent/schema";
import { EDIT_TOOLS } from "../agent/tool-names";
import type { ToolSpec } from "../tools/types";

export type PolicyDecision = { decision: "allow" } | { decision: "deny"; reason: string } | { decision: "require_approval" };

/**
 * How much the user wants to be asked, chosen per session and changeable mid-run.
 * - default:     the agent's approval list decides
 * - acceptEdits: file edits run without asking; other approval-gated tools still ask
 * - plan:        read-only; the agent investigates and proposes, nothing changes
 * - auto:        everything the agent is allowed to use runs without asking
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

export interface PolicyEvaluator {
  evaluate(toolName: string, input?: unknown): PolicyDecision;
}

export interface PolicyOptions {
  /** Read on every call, so a mode switch takes effect on the next tool call of a running turn. */
  mode?: () => PermissionMode;
  /** "Always allow" rules: a tool name, or shell:<command prefix>. Read on every call. */
  rules?: () => readonly string[];
}

/**
 * The rule recorded when the user picks "always allow" for a call. Shell is scoped to the command
 * (its first word, plus a subcommand if there is one), because allowing every shell command because
 * one `git status` was fine would be a surprise.
 */
export function allowRuleFor(toolName: string, input: unknown): string {
  if (toolName !== "shell") return toolName;
  const cmd = String((input as { command?: unknown } | undefined)?.command ?? "").trim();
  const words = cmd.split(/\s+/).filter(Boolean);
  const prefix = words.length > 1 && /^[a-z][\w.-]*$/i.test(words[1]) ? `${words[0]} ${words[1]}` : (words[0] ?? "");
  return `shell:${prefix}`;
}

export function ruleMatches(rule: string, toolName: string, input: unknown): boolean {
  if (rule === toolName) return true;
  if (toolName === "shell" && rule.startsWith("shell:")) {
    const prefix = rule.slice(6).trim();
    const cmd = String((input as { command?: unknown } | undefined)?.command ?? "").trim();
    // A prefix never authorizes a chained or piped command: "git status; rm -rf x" must still ask.
    if (/[;&|`$<>]|\n/.test(cmd)) return false;
    return Boolean(prefix) && (cmd === prefix || cmd.startsWith(`${prefix} `));
  }
  return false;
}

/** Local policy: the agent's own tool list, sandbox level, and approval list, adjusted by mode and rules. */
export function policyForAgent(agent: AgentDefinition, tools: ToolSpec[], opts: PolicyOptions = {}): PolicyEvaluator {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return {
    evaluate(toolName, input) {
      const spec = byName.get(toolName);
      if (!spec) return { decision: "deny", reason: `Tool "${toolName}" is not enabled for this agent` };
      if (agent.sandbox < spec.minSandbox) return { decision: "deny", reason: `Tool "${toolName}" requires sandbox level ${spec.minSandbox}` };
      const mode = opts.mode?.() ?? "default";
      if (mode === "plan" && spec.sideEffect) {
        return {
          decision: "deny",
          reason: `Plan mode is on: ${toolName} is not allowed because it changes things. Investigate with read-only tools, then present your plan to the user and wait for them to approve it and leave plan mode.`,
        };
      }
      const gated = (agent.approvals as string[]).includes(toolName) || (toolName.startsWith("mcp__") && spec.sideEffect);
      if (!gated) return { decision: "allow" };
      if (mode === "auto") return { decision: "allow" };
      if (mode === "acceptEdits" && (EDIT_TOOLS as readonly string[]).includes(toolName)) return { decision: "allow" };
      if ((opts.rules?.() ?? []).some((r) => ruleMatches(r, toolName, input))) return { decision: "allow" };
      return { decision: "require_approval" };
    },
  };
}
