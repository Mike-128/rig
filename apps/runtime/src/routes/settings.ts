import { Hono } from "hono";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext } from "../context";
import { SettingsSchema } from "../stores/settings";

export const RIG_VERSION = "0.5.0";
const INSTRUCTIONS_MAX = 64_000;
/** Probe results that mean the default model cannot be used; "unprobed" and "unknown" may still work. */
const BROKEN = new Set(["unauthorized", "forbidden", "not_found", "missing"]);

/** The facts the Setup checklist is built from: what is configured, and whether it works. */
export interface SetupStatus {
  version: string;
  home: string;
  secrets: string;
  connections: number;
  entitledModels: number;
  /** The model the "default" alias points at, and whether its last probe reached it. */
  defaultModel: { connection: string; model: string; status: string } | null;
  sessions: number;
  instructions: boolean;
  github: { host: string; login: string } | null;
  team: string | null;
  mcp: { configured: number; connected: number };
  skills: number;
  agents: number;
  /** True once Rig can run an agent: a default model whose last probe did not fail. */
  ready: boolean;
}

export function settingsRoutes(app: AppContext): Hono {
  const r = new Hono();
  const instructionsPath = () => path.join(app.config.home, "RIG.md");

  r.get("/settings", (c) => c.json(app.settings.get()));

  r.put("/settings", async (c) => {
    const parsed = SettingsSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid settings", issues: parsed.error.issues }, 400);
    for (const key of ["projectAgent", "chatAgent"] as const) {
      const slug = parsed.data[key];
      if (slug && !app.agents.get(slug)) return c.json({ error: `agent "${slug}" not found` }, 400);
    }
    return c.json(app.settings.set(parsed.data));
  });

  r.get("/instructions", (c) => {
    const file = instructionsPath();
    const exists = existsSync(file);
    return c.json({ path: file, exists, text: exists ? readFileSync(file, "utf8") : "" });
  });

  r.put("/instructions", async (c) => {
    const parsed = z.object({ text: z.string().max(INSTRUCTIONS_MAX) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: `instructions must be text under ${INSTRUCTIONS_MAX.toLocaleString()} characters` }, 400);
    const file = instructionsPath();
    // Clearing the text removes the file, so no empty section reaches the prompt.
    if (!parsed.data.text.trim()) rmSync(file, { force: true });
    else writeFileSync(file, parsed.data.text.endsWith("\n") ? parsed.data.text : parsed.data.text + "\n");
    return c.json({ path: file, exists: existsSync(file) });
  });

  r.get("/setup", (c) => {
    const connections = app.connections.list();
    const models = app.models.list();
    const alias = app.models.getAlias("default");
    const target = alias ? app.models.find(alias.connectionId, alias.modelId) : undefined;
    const defaultModel = alias
      ? {
          connection: connections.find((x) => x.id === alias.connectionId)?.name ?? alias.connectionId,
          model: alias.modelId,
          status: target?.status ?? "missing",
        }
      : null;
    const gh = app.github.status();
    const team = app.team.config();
    const mcp = app.mcp.status();
    const status: SetupStatus = {
      version: RIG_VERSION,
      home: app.config.home,
      secrets: app.secrets.backend,
      connections: connections.length,
      entitledModels: models.filter((m) => m.status === "entitled").length,
      defaultModel,
      sessions: app.sessions.listSessions(1).length,
      instructions: existsSync(instructionsPath()),
      github: gh ? { host: gh.host, login: gh.login } : null,
      team: team ? `${team.owner}/${team.repo}` : null,
      mcp: { configured: mcp.length, connected: mcp.filter((s) => s.status === "connected").length },
      skills: app.skills.list().length,
      agents: app.agents.list().length,
      ready: defaultModel !== null && !BROKEN.has(defaultModel.status),
    };
    return c.json(status);
  });

  return r;
}
