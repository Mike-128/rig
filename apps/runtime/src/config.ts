import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
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
  const home = overrides.home ?? process.env.HARNESS_HOME ?? path.join(os.homedir(), ".harness");
  const port = overrides.port ?? Number(process.env.HARNESS_PORT ?? 7777);
  const host = overrides.host ?? "127.0.0.1";
  const cfg: RuntimeConfig = {
    home,
    dbPath: path.join(home, "harness.db"),
    agentsDir: path.join(home, "agents"),
    workspacesDir: path.join(home, "workspaces"),
    profilesDir: path.join(home, "profiles"),
    skillsDir: path.join(home, "skills"),
    host,
    port,
    maxConcurrentRuns: Number(process.env.HARNESS_MAX_RUNS ?? 4),
    proxyToken: randomBytes(24).toString("hex"),
    proxyOrigin: `http://${host}:${port}`,
    ...overrides,
  };
  for (const d of [cfg.home, cfg.agentsDir, cfg.workspacesDir, cfg.profilesDir, cfg.skillsDir]) mkdirSync(d, { recursive: true });
  return cfg;
}
