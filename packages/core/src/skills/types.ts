/**
 * Agent Skills: a folder containing SKILL.md (YAML frontmatter with name and description,
 * plus an instruction body) and optional resource files. Engine-neutral by design.
 */

export interface Skill {
  name: string;
  description: string;
  /** The instruction body below the frontmatter. */
  body: string;
  /** Short content hash of SKILL.md, so a shared agent can be told the skill differs. */
  hash: string;
  source: "bundled" | "user";
  /** Absolute directory holding SKILL.md. */
  dir: string;
  /** Resource files beside SKILL.md, relative to `dir`. */
  files: string[];
}

/** What sits in context by default: enough for the model to decide whether to load the skill. */
export type SkillSummary = Omit<Skill, "body">;

export function toSummary(s: Skill): SkillSummary {
  const { body: _body, ...rest } = s;
  return rest;
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
