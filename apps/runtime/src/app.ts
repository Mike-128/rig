import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors } from "hono/cors";
import { loadConfig, type RuntimeConfig } from "./config";
import { openDb } from "./db";
import { openSecretStore } from "./secrets";
import { ConnectionStore } from "./stores/connections";
import { ModelStore } from "./stores/models";
import { AgentStore } from "./stores/agents";
import { SessionStore } from "./stores/sessions";
import { ProfileStore } from "./stores/profiles";
import { SkillStore } from "./stores/skills";
import { RunManager } from "./scheduler";
import type { AppContext } from "./context";
import { proxyRoutes } from "./proxy";
import { catalogRoutes } from "./routes/catalog";
import { agentRoutes } from "./routes/agents";
import { sessionRoutes } from "./routes/sessions";
import { skillRoutes } from "./routes/skills";
import { seedDefaults } from "./seed";
import { McpManager } from "./mcp";
import { mcpRoutes } from "./routes/mcp";
import { GitHubAuth, type GitHubConnection } from "./github";
import { TeamManager } from "./team";
import { MemoryStore } from "./stores/memory";
import { teamRoutes } from "./routes/team";
import { memoryRoutes } from "./routes/memory";
import { RIG_VERSION, settingsRoutes } from "./routes/settings";
import { SettingsStore } from "./stores/settings";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export interface BuiltApp {
  app: AppContext;
  hono: Hono;
}

export interface BuildOptions {
  fileSecrets?: boolean;
  /** Tests point GitHub at a mock: its fetch and API base. */
  github?: { fetch?: typeof fetch; apiBase?: string };
}

export async function buildApp(overrides: Partial<RuntimeConfig> = {}, opts: BuildOptions = {}): Promise<BuiltApp> {
  const config = loadConfig(overrides);
  const db = openDb(config.dbPath);
  const secrets = await openSecretStore(config.home, { forceFile: opts.fileSecrets });
  const runs = new RunManager(config.maxConcurrentRuns);
  const githubState = path.join(config.home, "github.json");
  const github = new GitHubAuth(
    secrets,
    () => (existsSync(githubState) ? (JSON.parse(readFileSync(githubState, "utf8")) as GitHubConnection) : undefined),
    (c) => (c ? writeFileSync(githubState, JSON.stringify(c, null, 2)) : rmSync(githubState, { force: true })),
    opts.github?.fetch,
    opts.github?.apiBase,
  );
  const team = new TeamManager(config.home, github);
  const teamDir = () => team.repoDir();
  const app: AppContext = {
    config,
    db,
    secrets,
    connections: new ConnectionStore(db),
    models: new ModelStore(db),
    agents: new AgentStore(db, config.agentsDir, teamDir),
    sessions: new SessionStore(db),
    profiles: new ProfileStore(config.profilesDir),
    skills: new SkillStore(config.skillsDir, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills"), config.claudeSkillsDir, teamDir),
    runs,
    mcp: new McpManager(config.home),
    github,
    team,
    memory: new MemoryStore(path.join(config.home, "memory"), () => team.repoDir()),
    settings: new SettingsStore(config.home),
  };
  runs.attach(app);
  runs.extraTools = () => app.mcp.tools();
  // Servers connect in the background; runs started before they finish just do not see their tools yet.
  void app.mcp.start();
  // The team repo syncs at startup and every few minutes, so merged reviews reach everyone without a click.
  const syncTeam = () => void team.sync().catch(() => {});
  if (team.config() && github.status()) syncTeam();
  const timer = setInterval(() => team.config() && github.status() && syncTeam(), 5 * 60_000);
  timer.unref();
  const interrupted = app.sessions.failInterrupted();
  if (interrupted) console.log(`[rig] marked ${interrupted} interrupted run(s) as failed`);
  seedDefaults(app);

  const hono = new Hono();
  hono.use("/api/*", cors({ origin: (o) => (o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : ""), credentials: false }));
  hono.get("/api/health", (c) => c.json({ ok: true, secrets: secrets.backend, home: config.home, version: RIG_VERSION, skills: app.skills.list().length }));
  hono.route("/proxy", proxyRoutes(app));
  hono.route("/api", catalogRoutes(app));
  hono.route("/api/agents", agentRoutes(app));
  hono.route("/api/skills", skillRoutes(app));
  hono.route("/api", sessionRoutes(app));
  hono.route("/api/mcp", mcpRoutes(app));
  hono.route("/api", teamRoutes(app));
  hono.route("/api/memory", memoryRoutes(app));
  hono.route("/api", settingsRoutes(app));
  hono.onError((err, c) => {
    console.error("[rig] unhandled", err);
    return c.json({ error: err.message }, 500);
  });
  return { app, hono };
}
