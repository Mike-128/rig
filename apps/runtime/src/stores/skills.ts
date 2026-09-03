import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isParseError,
  parseSkillMarkdown,
  renderSkillMarkdown,
  skillHash,
  SKILL_NAME_RE,
  toSummary,
  type Skill,
  type SkillSummary,
} from "@harness/core";
import { resolveInWorkspace } from "@harness/core";

export interface SkillIssue {
  dir: string;
  error: string;
}

/**
 * Skills are folders holding SKILL.md plus optional resources.
 * Bundled skills ship with the app; user skills live under HARNESS_HOME/skills and win on name collisions.
 */
export class SkillStore {
  private issues: SkillIssue[] = [];

  constructor(
    private userDir: string,
    private bundledDir?: string,
  ) {
    mkdirSync(userDir, { recursive: true });
  }

  private scanDir(dir: string, source: Skill["source"]): Skill[] {
    if (!existsSync(dir)) return [];
    const out: Skill[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
      if (parsed.name !== entry.name) {
        this.issues.push({ dir: skillDir, error: `frontmatter name "${parsed.name}" does not match the folder name "${entry.name}"` });
        continue;
      }
      out.push({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        hash: skillHash(text),
        source,
        dir: skillDir,
        files: this.resourceFiles(skillDir),
      });
    }
    return out;
  }

  private resourceFiles(dir: string, prefix = ""): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...this.resourceFiles(path.join(dir, e.name), rel));
      else if (rel !== "SKILL.md") out.push(rel);
    }
    return out.sort();
  }

  /** User skills shadow bundled ones of the same name. */
  all(): Skill[] {
    this.issues = [];
    const bundled = this.bundledDir ? this.scanDir(this.bundledDir, "bundled") : [];
    const user = this.scanDir(this.userDir, "user");
    const names = new Set(user.map((s) => s.name));
    return [...user, ...bundled.filter((s) => !names.has(s.name))].sort((a, b) => a.name.localeCompare(b.name));
  }

  list(): SkillSummary[] {
    return this.all().map(toSummary);
  }

  names(): string[] {
    return this.all().map((s) => s.name);
  }

  problems(): SkillIssue[] {
    this.all();
    return this.issues;
  }

  get(name: string): Skill | undefined {
    return this.all().find((s) => s.name === name);
  }

  /** Read a resource bundled with a skill. Paths cannot escape the skill directory. */
  readFile(name: string, file: string): string | undefined {
    const skill = this.get(name);
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

  /** Create or replace a user skill. Bundled skills are never modified; writing the same name shadows it. */
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

  delete(name: string): { ok: boolean; error?: string } {
    const dir = path.join(this.userDir, name);
    if (!existsSync(dir)) return { ok: false, error: `no user skill named "${name}" (bundled skills cannot be deleted)` };
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  }
}
