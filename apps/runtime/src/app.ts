import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig, type RuntimeConfig } from "./config";
import { openDb } from "./db";
import { openSecretStore } from "./secrets";
import { ConnectionStore } from "./stores/connections";
import { ModelStore } from "./stores/models";
import { AgentStore } from "./stores/agents";
import { SessionStore } from "./stores/sessions";
import { ProfileStore } from "./stores/profiles";
import { RunManager } from "./scheduler";
import type { AppContext } from "./context";
import { proxyRoutes } from "./proxy";
import { catalogRoutes } from "./routes/catalog";
import { agentRoutes } from "./routes/agents";
import { sessionRoutes } from "./routes/sessions";
import { seedDefaults } from "./seed";

export interface BuiltApp {
  app: AppContext;
  hono: Hono;
}

export async function buildApp(overrides: Partial<RuntimeConfig> = {}, opts: { fileSecrets?: boolean } = {}): Promise<BuiltApp> {
  const config = loadConfig(overrides);
  const db = openDb(config.dbPath);
  const secrets = await openSecretStore(config.home, { forceFile: opts.fileSecrets });
  const runs = new RunManager(config.maxConcurrentRuns);
  const app: AppContext = {
    config,
    db,
    secrets,
    connections: new ConnectionStore(db),
    models: new ModelStore(db),
    agents: new AgentStore(db, config.agentsDir),
    sessions: new SessionStore(db),
    profiles: new ProfileStore(config.profilesDir),
    runs,
  };
  runs.attach(app);
  const interrupted = app.sessions.failInterrupted();
  if (interrupted) console.log(`[harness] marked ${interrupted} interrupted run(s) as failed`);
  seedDefaults(app);

  const hono = new Hono();
  hono.use("/api/*", cors({ origin: (o) => (o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : ""), credentials: false }));
  hono.get("/api/health", (c) => c.json({ ok: true, secrets: secrets.backend, home: config.home, version: "0.1.0" }));
  hono.route("/proxy", proxyRoutes(app));
  hono.route("/api", catalogRoutes(app));
  hono.route("/api/agents", agentRoutes(app));
  hono.route("/api", sessionRoutes(app));
  hono.onError((err, c) => {
    console.error("[harness] unhandled", err);
    return c.json({ error: err.message }, 500);
  });
  return { app, hono };
}
