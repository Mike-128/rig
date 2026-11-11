import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** Never worth searching, and often huge. */
const ALWAYS_SKIP = new Set([".git", "node_modules", ".hg", ".svn", "__pycache__", ".venv", "venv", ".next", ".turbo", ".cache"]);

interface IgnoreRule {
  pattern: string;
  dirOnly: boolean;
  anchored: boolean;
}

/**
 * A small .gitignore reader: plain names, globs, anchored (leading /) and directory-only (trailing /)
 * patterns from the root .gitignore. Negations are not supported; they are rare in practice and
 * erring towards searching more is safe.
 */
function loadIgnore(root: string): IgnoreRule[] {
  let text: string;
  try {
    text = readFileSync(path.join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    rules.push({ pattern: line, dirOnly, anchored });
  }
  return rules;
}

function ignored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const target = r.anchored ? rel : base;
    if (target === r.pattern || path.posix.matchesGlob(target, r.pattern)) return true;
  }
  return false;
}

export interface WalkEntry {
  /** Absolute path. */
  abs: string;
  /** Path relative to the walk root, with forward slashes. */
  rel: string;
}

/** Files under `dir`, skipping VCS and dependency folders and what the workspace .gitignore excludes. */
export async function* walkFiles(workspace: string, dir: string, signal?: AbortSignal): AsyncGenerator<WalkEntry> {
  const rules = loadIgnore(workspace);
  const stack = [dir];
  while (stack.length) {
    if (signal?.aborted) return;
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(current, e.name);
      const fromRoot = path.relative(workspace, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name) || ignored(rules, fromRoot, true)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        if (ignored(rules, fromRoot, false)) continue;
        yield { abs, rel: path.relative(dir, abs).split(path.sep).join("/") };
      }
    }
  }
}
