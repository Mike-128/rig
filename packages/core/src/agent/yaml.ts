import { parse, stringify } from "yaml";
import type { AgentDefinition } from "./schema";

const FIELD_ORDER: (keyof AgentDefinition)[] = [
  "name",
  "slug",
  "description",
  "version",
  "engine",
  "model",
  "instructions",
  "tools",
  "skills",
  "knowledge",
  "memory",
  "sandbox",
  "approvals",
  "budget",
  "params",
];

export function agentToYaml(def: AgentDefinition): string {
  const ordered: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) {
    if (k in def && (def as Record<string, unknown>)[k] !== undefined) {
      ordered[k] = (def as Record<string, unknown>)[k];
    }
  }
  for (const [k, v] of Object.entries(def)) {
    if (!(k in ordered) && v !== undefined) ordered[k] = v;
  }
  return stringify(ordered, { lineWidth: 100 });
}

export function agentFromYaml(text: string): unknown {
  return parse(text);
}
