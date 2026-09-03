import { createHash } from "node:crypto";
import { parse } from "yaml";
import { SKILL_NAME_RE } from "./types";

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

export interface ParseError {
  error: string;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse a SKILL.md: YAML frontmatter with name and description, then the instruction body. */
export function parseSkillMarkdown(text: string): ParsedSkill | ParseError {
  const m = text.match(FRONTMATTER);
  if (!m) return { error: "SKILL.md must start with YAML frontmatter delimited by --- lines" };
  let fm: unknown;
  try {
    fm = parse(m[1]);
  } catch (e) {
    return { error: `frontmatter is not valid YAML: ${(e as Error).message}` };
  }
  if (typeof fm !== "object" || fm === null) return { error: "frontmatter must be a YAML mapping" };
  const { name, description } = fm as { name?: unknown; description?: unknown };
  if (typeof name !== "string" || !name.trim()) return { error: "frontmatter needs a name" };
  if (!SKILL_NAME_RE.test(name)) return { error: `name "${name}" must be lowercase letters, digits, and dashes` };
  if (typeof description !== "string" || !description.trim()) return { error: "frontmatter needs a description (this is what the model sees when deciding to load the skill)" };
  const body = m[2].trim();
  if (!body) return { error: "SKILL.md has no instruction body below the frontmatter" };
  return { name, description: description.trim(), body };
}

export function isParseError(x: ParsedSkill | ParseError): x is ParseError {
  return "error" in x;
}

export function skillHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

export function renderSkillMarkdown(name: string, description: string, body: string): string {
  const esc = (s: string) => (/[:#]|^\s|\s$/.test(s) ? JSON.stringify(s) : s);
  return `---\nname: ${esc(name)}\ndescription: ${esc(description)}\n---\n\n${body.trim()}\n`;
}
