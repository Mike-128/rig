import type { AgentDefinition } from "../agent/schema";
import type { ToolSpec } from "../tools/types";

export type PolicyDecision = { decision: "allow" } | { decision: "deny"; reason: string } | { decision: "require_approval" };

export interface PolicyEvaluator {
  evaluate(toolName: string): PolicyDecision;
}

/** Local policy: the agent's own tool list, sandbox level, and approval list. */
export function policyForAgent(agent: AgentDefinition, tools: ToolSpec[]): PolicyEvaluator {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return {
    evaluate(toolName) {
      const spec = byName.get(toolName);
      if (!spec) return { decision: "deny", reason: `Tool "${toolName}" is not enabled for this agent` };
      if (agent.sandbox < spec.minSandbox) return { decision: "deny", reason: `Tool "${toolName}" requires sandbox level ${spec.minSandbox}` };
      if ((agent.approvals as string[]).includes(toolName)) return { decision: "require_approval" };
      return { decision: "allow" };
    },
  };
}
