import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentFromYaml, agentToYaml, validateAgentDefinition, type AgentDefinition, type AgentSummary, type ValidateOptions, type ValidationResult } from "@rig/core";
import { nowIso, type Db } from "../db";

/**
 * Agents live as YAML files (the shareable artifact) with a SQLite index.
 * Saving bumps the version and archives the previous file under history/.
 *
 * Team agents come from the synced team repo and are read-only here: changing one goes through a
 * pull request. A local agent with the same slug shadows the team one, so a person can try changes
 * before proposing them.
 */
export class AgentStore {
  constructor(
    private db: Db,
    private dir: string,
    private teamDir: () => string | undefined = () => undefined,
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

  private teamFile(slug: string): string | undefined {
    const d = this.teamDir();
    if (!d) return undefined;
    const p = path.join(d, "agents", `${slug}.yaml`);
    return existsSync(p) ? p : undefined;
  }

  /** Team agents that parse and validate; a broken file in the repo is skipped, not fatal. */
  teamAgents(): AgentDefinition[] {
    const d = this.teamDir();
    const dir = d && path.join(d, "agents");
    if (!dir || !existsSync(dir)) return [];
    const out: AgentDefinition[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".yaml")) continue;
      try {
        const v = validateAgentDefinition(agentFromYaml(readFileSync(path.join(dir, f), "utf8")));
        if (v.definition && v.definition.slug === f.slice(0, -5)) out.push(v.definition);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  list(): AgentSummary[] {
    const team = new Map(this.teamAgents().map((a) => [a.slug, a]));
    const local = (
      this.db.prepare("SELECT slug, name, description, version, updated_at as updatedAt FROM agents ORDER BY name").all() as unknown as AgentSummary[]
    ).map((a) => ({ ...a, description: a.description ?? undefined, source: "local" as const, inTeam: team.has(a.slug) }));
    const localSlugs = new Set(local.map((a) => a.slug));
    const teamOnly = [...team.values()]
      .filter((a) => !localSlugs.has(a.slug))
      .map((a) => ({ slug: a.slug, name: a.name, description: a.description, version: a.version, updatedAt: "", source: "team" as const }));
    return [...local, ...teamOnly].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The agent a run uses: the local one if present, else the team's. */
  get(slug: string): AgentDefinition | undefined {
    const p = existsSync(this.filePath(slug)) ? this.filePath(slug) : this.teamFile(slug);
    if (!p) return undefined;
    const v = validateAgentDefinition(agentFromYaml(readFileSync(p, "utf8")));
    return v.definition;
  }

  /** The team repo's version of an agent, ignoring any local copy. */
  getTeam(slug: string): AgentDefinition | undefined {
    const p = this.teamFile(slug);
    return p ? validateAgentDefinition(agentFromYaml(readFileSync(p, "utf8"))).definition : undefined;
  }

  isLocal(slug: string): boolean {
    return existsSync(this.filePath(slug));
  }

  getYaml(slug: string): string | undefined {
    const p = existsSync(this.filePath(slug)) ? this.filePath(slug) : this.teamFile(slug);
    return p ? readFileSync(p, "utf8") : undefined;
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
