import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentFromYaml, agentToYaml, validateAgentDefinition, type AgentDefinition, type AgentSummary, type ValidateOptions, type ValidationResult } from "@rig/core";
import { nowIso, type Db } from "../db";

/**
 * Agents live as YAML files (the shareable artifact) with a SQLite index.
 * Saving bumps the version and archives the previous file under history/.
 */
export class AgentStore {
  constructor(
    private db: Db,
    private dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.reindex();
  }

  private filePath(slug: string): string {
    return path.join(this.dir, `${slug}.yaml`);
  }

  private historyDir(slug: string): string {
    return path.join(this.dir, "history", slug);
  }

  /** Pick up YAML files dropped into the directory by hand. */
  reindex(): void {
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".yaml")) continue;
      const slug = f.slice(0, -5);
      const row = this.db.prepare("SELECT slug FROM agents WHERE slug = ?").get(slug);
      if (row) continue;
      const v = validateAgentDefinition(agentFromYaml(readFileSync(this.filePath(slug), "utf8")));
      if (v.ok && v.definition) this.index(v.definition);
    }
  }

  private index(def: AgentDefinition): void {
    this.db
      .prepare(
        "INSERT INTO agents (slug, name, description, version, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description, version=excluded.version, updated_at=excluded.updated_at",
      )
      .run(def.slug, def.name, def.description ?? null, def.version, nowIso());
  }

  list(): AgentSummary[] {
    return (
      this.db.prepare("SELECT slug, name, description, version, updated_at as updatedAt FROM agents ORDER BY name").all() as unknown as AgentSummary[]
    ).map((a) => ({ ...a, description: a.description ?? undefined }));
  }

  get(slug: string): AgentDefinition | undefined {
    const p = this.filePath(slug);
    if (!existsSync(p)) return undefined;
    const v = validateAgentDefinition(agentFromYaml(readFileSync(p, "utf8")));
    return v.definition;
  }

  getYaml(slug: string): string | undefined {
    const p = this.filePath(slug);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  getVersion(slug: string, version: number): AgentDefinition | undefined {
    const current = this.get(slug);
    if (current?.version === version) return current;
    const p = path.join(this.historyDir(slug), `v${version}.yaml`);
    if (!existsSync(p)) return undefined;
    return validateAgentDefinition(agentFromYaml(readFileSync(p, "utf8"))).definition;
  }

  /** Validate and save. A new version is created only when content changed. */
  save(input: unknown, opts: ValidateOptions = {}): ValidationResult & { saved?: AgentDefinition } {
    const v = validateAgentDefinition(input, opts);
    if (!v.ok || !v.definition) return v;
    const incoming = v.definition;
    const existing = this.get(incoming.slug);
    let def = incoming;
    if (existing) {
      const same = agentToYaml({ ...existing, version: 0 }) === agentToYaml({ ...incoming, version: 0 });
      if (same) return { ...v, saved: existing, definition: existing };
      const hist = this.historyDir(incoming.slug);
      mkdirSync(hist, { recursive: true });
      writeFileSync(path.join(hist, `v${existing.version}.yaml`), agentToYaml(existing), "utf8");
      def = { ...incoming, version: existing.version + 1 };
    } else {
      def = { ...incoming, version: 1 };
    }
    writeFileSync(this.filePath(def.slug), agentToYaml(def), "utf8");
    this.index(def);
    return { ...v, definition: def, saved: def };
  }

  delete(slug: string): void {
    const p = this.filePath(slug);
    if (existsSync(p)) unlinkSync(p);
    this.db.prepare("DELETE FROM agents WHERE slug = ?").run(slug);
  }
}
