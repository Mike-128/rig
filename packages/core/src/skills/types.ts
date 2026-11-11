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
  /**
   * Where it was found. Precedence on a name clash: project > user > claude > bundled.
   * - project: the workspace's .rig/skills or .claude/skills
   * - user:    ~/.rig/skills (including skills installed from GitHub)
   * - claude:  ~/.claude/skills, so skills set up for Claude Code work here too
   * - bundled: shipped with Rig
   */
  source: "bundled" | "user" | "claude" | "project";
  /** Set for skills installed from GitHub, so they can be updated from the same place. */
  origin?: SkillOrigin;
  /** Absolute directory holding SKILL.md. */
  dir: string;
  /** Resource files beside SKILL.md, relative to `dir`. */
  files: string[];
}

export interface SkillOrigin {
  repo: string;
  ref: string;
  path: string;
  /** Commit the files were taken from. */
  sha?: string;
  installedAt: string;
}

/** What sits in context by default: enough for the model to decide whether to load the skill. */
export type SkillSummary = Omit<Skill, "body">;

export function toSummary(s: Skill): SkillSummary {
  const { body: _body, ...rest } = s;
  return rest;
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
