import type { Skill, SkillSummary } from "../skills/types";

export interface HostAgentSummary {
  slug: string;
  name: string;
  description?: string;
  version: number;
}

export interface HostModelSummary {
  /** Connection name, as an agent definition would reference it. */
  connection: string;
  /** Provider model id, as an agent definition would reference it. */
  model: string;
  dialect: string;
  status: string;
  aliases: string[];
  reasoning: boolean;
}

export interface HostWriteResult {
  ok: boolean;
  issues: { path: string; message: string; severity: "error" | "warning" }[];
  slug?: string;
  version?: number;
  yaml?: string;
}

/**
 * Capabilities the runtime lends to tools that manage the harness itself.
 * Core declares the interface; the runtime implements it against its stores.
 */
export interface HostServices {
  listAgents(): HostAgentSummary[];
  readAgentYaml(slug: string): string | undefined;
  writeAgent(definition: unknown): HostWriteResult;
  listModels(): HostModelSummary[];
  listSkills(): SkillSummary[];
  readSkill(name: string): Skill | undefined;
  readSkillFile(name: string, file: string): string | undefined;
  writeSkill(name: string, description: string, body: string): { ok: boolean; error?: string; hash?: string };
}
