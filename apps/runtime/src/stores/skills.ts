import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isParseError,
  parseSkillMarkdown,
  renderSkillMarkdown,
  resolveInWorkspace,
  skillHash,
  SKILL_NAME_RE,
  toSummary,
  type Skill,
  type SkillOrigin,
  type SkillSummary,
} from "@rig/core";
import type { FetchedSkill } from "../github-skills";

export interface SkillIssue {
  dir: string;
  error: string;
}

/** Records where a GitHub-installed skill came from, beside its SKILL.md. */
const ORIGIN_FILE = ".rig-origin.json";

/** Folders inside a workspace that hold project skills; .claude/skills is Claude Code's location. */
const PROJECT_SKILL_DIRS = [".rig/skills", ".claude/skills"];

/**
 * Skills are folders holding SKILL.md plus optional resources. They are found in four places,
 * and on a name clash the more specific one wins: the project's own skills, then the user's
 * (~/.rig/skills, where GitHub installs go), then Claude Code's (~/.claude/skills), then bundled.
 */
export class SkillStore {
  private issues: SkillIssue[] = [];

  constructor(
    private userDir: string,
    private bundledDir?: string,
    private claudeDir: string | null = null,
    private teamDir: () => string | undefined = () => undefined,
  ) {
    mkdirSync(userDir, { recursive: true });
  }

  private scanDir(dir: string, source: Skill["source"]): Skill[] {
    if (!existsSync(dir)) return [];
    const out: Skill[] = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      const md = path.join(skillDir, "SKILL.md");
      if (!existsSync(md)) continue;
      const text = readFileSync(md, "utf8");
      const parsed = parseSkillMarkdown(text);
      if (isParseError(parsed)) {
        this.issues.push({ dir: skillDir, error: parsed.error });
        continue;
      }
      if (parsed.name !== entry.name && source !== "claude" && source !== "project" && source !== "team") {
        this.issues.push({ dir: skillDir, error: `frontmatter name "${parsed.name}" does not match the folder name "${entry.name}"` });
        continue;
      }
      out.push({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        hash: skillHash(text),
        source,
        origin: readOrigin(skillDir),
        dir: skillDir,
        files: this.resourceFiles(skillDir),
      });
    }
    return out;
  }

  private resourceFiles(dir: string, prefix = ""): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ORIGIN_FILE || e.name === ".git") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...this.resourceFiles(path.join(dir, e.name), rel));
      else if (rel !== "SKILL.md") out.push(rel);
    }
    return out.sort();
  }

  /** Every skill visible from a workspace (or globally, without one): project, user, team, Claude Code, bundled. */
  all(workspace?: string): Skill[] {
    this.issues = [];
    const layers: Skill[][] = [];
    if (workspace) for (const d of PROJECT_SKILL_DIRS) layers.push(this.scanDir(path.join(workspace, d), "project"));
    layers.push(this.scanDir(this.userDir, "user"));
    const team = this.teamDir();
    if (team) layers.push(this.scanDir(path.join(team, "skills"), "team"));
    if (this.claudeDir) layers.push(this.scanDir(this.claudeDir, "claude"));
    if (this.bundledDir) layers.push(this.scanDir(this.bundledDir, "bundled"));
    const byName = new Map<string, Skill>();
    for (const layer of layers) for (const s of layer) if (!byName.has(s.name)) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  list(workspace?: string): SkillSummary[] {
    return this.all(workspace).map(toSummary);
  }

  names(workspace?: string): string[] {
    return this.all(workspace).map((s) => s.name);
  }

  problems(workspace?: string): SkillIssue[] {
    this.all(workspace);
    return this.issues;
  }

  get(name: string, workspace?: string): Skill | undefined {
    return this.all(workspace).find((s) => s.name === name);
  }

  /** Read a resource bundled with a skill. Paths cannot escape the skill directory. */
  readFile(name: string, file: string, workspace?: string): string | undefined {
    const skill = this.get(name, workspace);
    if (!skill) return undefined;
    let abs: string;
    try {
      abs = resolveInWorkspace(skill.dir, file);
    } catch {
      return undefined;
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) return undefined;
    return readFileSync(abs, "utf8");
  }

  /** Create or replace a user skill. Other sources are never modified; writing the same name shadows them. */
  write(name: string, description: string, body: string): { ok: boolean; error?: string; hash?: string } {
    if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `name "${name}" must be lowercase letters, digits, and dashes` };
    const text = renderSkillMarkdown(name, description, body);
    const check = parseSkillMarkdown(text);
    if (isParseError(check)) return { ok: false, error: check.error };
    const dir = path.join(this.userDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), text, "utf8");
    return { ok: true, hash: skillHash(text) };
  }

  /** Import a raw SKILL.md, taking the name from its frontmatter. */
  importMarkdown(text: string): { ok: boolean; error?: string; name?: string; hash?: string } {
    const parsed = parseSkillMarkdown(text);
    if (isParseError(parsed)) return { ok: false, error: parsed.error };
    const res = this.write(parsed.name, parsed.description, parsed.body);
    return res.ok ? { ok: true, name: parsed.name, hash: res.hash } : { ok: false, error: res.error };
  }

  /**
   * Install skills downloaded from GitHub into the user directory, replacing an earlier install of
   * the same name. Files are written only inside the skill's own folder.
   */
  installFetched(fetched: FetchedSkill[], origin: Omit<SkillOrigin, "path" | "installedAt">): { installed: string[]; errors: { name: string; error: string }[] } {
    const installed: string[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const s of fetched) {
      if (!SKILL_NAME_RE.test(s.name)) {
        errors.push({ name: s.name, error: "invalid skill name" });
        continue;
      }
      const dir = path.join(this.userDir, s.name);
      const staging = `${dir}.installing`;
      try {
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true });
        for (const f of s.files) {
          const abs = resolveInWorkspace(staging, f.rel);
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, f.data);
        }
        const info: SkillOrigin = { ...origin, path: s.path, installedAt: new Date().toISOString() };
        writeFileSync(path.join(staging, ORIGIN_FILE), JSON.stringify(info, null, 2));
        const md = readFileSync(path.join(staging, "SKILL.md"), "utf8");
        const parsed = parseSkillMarkdown(md);
        if (isParseError(parsed)) throw new Error(parsed.error);
        rmSync(dir, { recursive: true, force: true });
        renameDir(staging, dir);
        installed.push(s.name);
      } catch (e) {
        rmSync(staging, { recursive: true, force: true });
        errors.push({ name: s.name, error: (e as Error).message });
      }
    }
    return { installed, errors };
  }

  delete(name: string): { ok: boolean; error?: string } {
    const dir = path.join(this.userDir, name);
    if (!existsSync(dir)) return { ok: false, error: `no user skill named "${name}" (bundled, Claude Code, and project skills are not deleted from here)` };
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  }
}

function readOrigin(dir: string): SkillOrigin | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, ORIGIN_FILE), "utf8")) as SkillOrigin;
  } catch {
    return undefined;
  }
}

function renameDir(from: string, to: string): void {
  // fs.renameSync on Windows can fail transiently while antivirus scans new files; retry briefly.
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 5) throw e;
      const until = Date.now() + 100 * (i + 1);
      while (Date.now() < until) {
        /* wait */
      }
    }
  }
}
