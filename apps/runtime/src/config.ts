import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface RuntimeConfig {
  home: string;
  dbPath: string;
  agentsDir: string;
  workspacesDir: string;
  profilesDir: string;
  skillsDir: string;
  host: string;
  port: number;
  maxConcurrentRuns: number;
  proxyToken: string;
  /** Origin the engines use to reach the loopback proxy. */
  proxyOrigin: string;
}

export function loadConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const home = overrides.home ?? process.env.RIG_HOME ?? path.join(os.homedir(), ".rig");
  const port = overrides.port ?? Number(process.env.RIG_PORT ?? 7777);
  const host = overrides.host ?? "127.0.0.1";
  const cfg: RuntimeConfig = {
    home,
    dbPath: path.join(home, "rig.db"),
    agentsDir: path.join(home, "agents"),
    workspacesDir: path.join(home, "workspaces"),
    profilesDir: path.join(home, "profiles"),
    skillsDir: path.join(home, "skills"),
    host,
    port,
    maxConcurrentRuns: Number(process.env.RIG_MAX_RUNS ?? 4),
    proxyToken: randomBytes(24).toString("hex"),
    proxyOrigin: `http://${host}:${port}`,
    ...overrides,
  };
  migrateLegacyHome(cfg);
  for (const d of [cfg.home, cfg.agentsDir, cfg.workspacesDir, cfg.profilesDir, cfg.skillsDir]) mkdirSync(d, { recursive: true });
  return cfg;
}

/**
 * Move a pre-rename data directory into place. Exported so the sidecar handling is testable.
 * Returns true when a migration happened.
 */
export function migrateHomeDirectory(legacy: string, target: string, dbPath: string): boolean {
  if (existsSync(target) || !existsSync(legacy)) return false;
  renameSync(legacy, target);
  // SQLite's -wal and -shm files must travel with the database. The write-ahead log can hold
  // committed rows that have not been folded into the main file yet, so renaming the main file
  // alone silently orphans them and loses data.
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = path.join(target, `harness.db${suffix}`);
    const to = `${dbPath}${suffix}`;
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  }
  return true;
}

/**
 * The data directory was ~/.harness before the project was renamed to Rig.
 * Move it across once, so an existing install keeps its connections, agents, and history.
 * Only touches the default location, and never overwrites an existing ~/.rig.
 */
function migrateLegacyHome(cfg: RuntimeConfig): void {
  if (cfg.home !== path.join(os.homedir(), ".rig")) return;
  const legacy = path.join(os.homedir(), ".harness");
  try {
    if (migrateHomeDirectory(legacy, cfg.home, cfg.dbPath)) console.log(`[rig] migrated ${legacy} to ${cfg.home}`);
  } catch (e) {
    console.warn(`[rig] could not migrate ${legacy}: ${(e as Error).message}. Move it by hand to keep your data.`);
  }
}
