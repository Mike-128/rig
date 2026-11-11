import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseMemory, renderMemory, validateMemoryInput, type Memory, type MemoryInput, type MemoryScope, type MemorySummary } from "@rig/core";

/**
 * Personal memory lives in ~/.rig/memory and is written directly. Team memory is read from the
 * synced team repo; changing it goes through the team manager as a reviewed pull request.
 */
export class MemoryStore {
  constructor(
    private personalDir: string,
    private teamDir: () => string | undefined,
  ) {
    mkdirSync(personalDir, { recursive: true });
  }

  private scan(dir: string | undefined, scope: MemoryScope): Memory[] {
    if (!dir || !existsSync(dir)) return [];
    const out: Memory[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const m = parseMemory(readFileSync(path.join(dir, f), "utf8"), scope);
      if (!("error" in m)) out.push(m);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private teamMemoryDir(): string | undefined {
    const d = this.teamDir();
    return d ? path.join(d, "memory") : undefined;
  }

  all(): Memory[] {
    return [...this.scan(this.personalDir, "personal"), ...this.scan(this.teamMemoryDir(), "team")];
  }

  list(): MemorySummary[] {
    return this.all().map(({ body: _b, ...rest }) => rest);
  }

  /** Personal wins when no scope is given and both have the name: it is the user's own override. */
  get(name: string, scope?: MemoryScope): Memory | undefined {
    const all = this.all().filter((m) => m.name === name && (!scope || m.scope === scope));
    return all.find((m) => m.scope === "personal") ?? all[0];
  }

  writePersonal(input: MemoryInput, author?: string): { ok: boolean; error?: string } {
    const err = validateMemoryInput(input);
    if (err) return { ok: false, error: err };
    writeFileSync(path.join(this.personalDir, `${input.name}.md`), renderMemory({ ...input, author, updated: today() }), "utf8");
    return { ok: true };
  }

  deletePersonal(name: string): boolean {
    const p = path.join(this.personalDir, `${name}.md`);
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  }
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
