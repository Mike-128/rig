import type { Skill, SkillSummary } from "../skills/types";
import type { Memory, MemoryInput, MemoryScope, MemorySummary } from "../memory/types";

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
 * Capabilities the runtime lends to tools that manage the rig itself.
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
  /** Personal and team memories. Optional so hosts without memory still satisfy the interface. */
  listMemories?(): MemorySummary[];
  readMemory?(name: string, scope?: MemoryScope): Memory | undefined;
  /** Personal writes apply at once; team writes are staged for a reviewed pull request. */
  writeMemory?(scope: MemoryScope, change: MemoryInput | { name: string; delete: true }): Promise<{ ok: boolean; error?: string; message?: string }>;
}
