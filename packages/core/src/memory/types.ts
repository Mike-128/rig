import { parse, stringify } from "yaml";

/**
 * Memory: durable notes an agent (or a person) writes so later sessions start knowing them.
 * One fact per markdown file, YAML frontmatter then body, which keeps git merges trivial and lets
 * a pull request show exactly which fact changed.
 *
 * Two scopes: personal (~/.rig/memory, written directly) and team (memory/ in the team repo,
 * changed only through a reviewed pull request).
 */

export const MEMORY_TYPES = ["fact", "decision", "convention", "gotcha", "preference", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryScope = "personal" | "team";

export const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Memories are notes, not documents: the size cap keeps the repo from becoming storage. */
export const MEMORY_MAX_BODY = 8_000;

export interface MemorySummary {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  author?: string;
  updated?: string;
}

export interface Memory extends MemorySummary {
  body: string;
}

export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseMemory(text: string, scope: MemoryScope): Memory | { error: string } {
  const m = text.match(FRONTMATTER);
  if (!m) return { error: "a memory starts with YAML frontmatter between --- lines" };
  let fm: Record<string, unknown>;
  try {
    fm = (parse(m[1]) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return { error: `frontmatter is not valid YAML: ${(e as Error).message}` };
  }
  const name = String(fm.name ?? "");
  if (!MEMORY_NAME_RE.test(name)) return { error: `name "${name}" must be lowercase letters, digits, and dashes` };
  const description = String(fm.description ?? "").trim();
  if (!description) return { error: "a memory needs a one-line description" };
  const type = (MEMORY_TYPES as readonly string[]).includes(String(fm.type)) ? (fm.type as MemoryType) : "fact";
  return {
    name,
    description,
    type,
    scope,
    author: fm.author ? String(fm.author) : undefined,
    updated: fm.updated ? String(fm.updated) : undefined,
    body: m[2].trim(),
  };
}

export function validateMemoryInput(m: MemoryInput): string | undefined {
  if (!MEMORY_NAME_RE.test(m.name)) return `name "${m.name}" must be lowercase letters, digits, and dashes (max 64)`;
  if (!m.description?.trim()) return "description is required: one line saying what the memory is about";
  if (m.description.length > 300) return "description must be one line (300 characters at most)";
  if (!(MEMORY_TYPES as readonly string[]).includes(m.type)) return `type must be one of ${MEMORY_TYPES.join(", ")}`;
  if (!m.body?.trim()) return "body is required";
  if (m.body.length > MEMORY_MAX_BODY) return `body is ${m.body.length} characters; memories are short notes (max ${MEMORY_MAX_BODY}). Link to the source instead of copying it.`;
  return undefined;
}

export function renderMemory(m: MemoryInput & { author?: string; updated?: string }): string {
  const fm: Record<string, string> = { name: m.name, description: m.description.trim(), type: m.type };
  if (m.author) fm.author = m.author;
  if (m.updated) fm.updated = m.updated;
  return `---\n${stringify(fm).trimEnd()}\n---\n\n${m.body.trim()}\n`;
}
