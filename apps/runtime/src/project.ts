import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectInstructions, PromptContext } from "@rig/core";

const MAX_CHARS = 40_000;

/**
 * Instruction files a project can carry, in the order they are read. AGENTS.md is the cross-tool
 * convention; CLAUDE.md is read too so projects set up for Claude Code work unchanged.
 */
const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md", "RIG.md", ".rig/RIG.md"];

function readCapped(file: string): string | undefined {
  try {
    if (!statSync(file).isFile()) return undefined;
    const text = readFileSync(file, "utf8").trim();
    if (!text) return undefined;
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[truncated]` : text;
  } catch {
    return undefined;
  }
}

/** The user's own standing instructions for every project, plus the workspace's instruction files. */
export function loadProjectInstructions(workspace: string, rigHome: string): ProjectInstructions[] {
  const out: ProjectInstructions[] = [];
  const seen = new Set<string>();
  const add = (file: string, label: string) => {
    const text = readCapped(file);
    // A CLAUDE.md that only says "see AGENTS.md" would otherwise appear twice in spirit; identical text appears once.
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push({ file: label, text });
    }
  };
  add(path.join(rigHome, "RIG.md"), "~/.rig/RIG.md (your global instructions)");
  for (const f of PROJECT_FILES) add(path.join(workspace, f), f);
  return out;
}

export function environmentFacts(workspace: string): NonNullable<PromptContext["env"]> {
  return {
    platform: `${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"} (${os.release()})`,
    shell: process.platform === "win32" ? "PowerShell" : "bash",
    date: new Date().toISOString().slice(0, 10),
    isGitRepo: existsSync(path.join(workspace, ".git")),
  };
}
