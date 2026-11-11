import { Hono } from "hono";
import { z } from "zod";
import { agentToYaml, validateAgentDefinition, type AgentDefinition } from "@rig/core";
import type { AppContext } from "../context";
import { TeamManager } from "../team";

const fail = (e: unknown) => ({ error: (e as Error).message });

/** "owner/repo", or any github URL to the repo. */
function parseRepo(input: string): { owner: string; repo: string } | undefined {
  const m = input.trim().replace(/\.git$/, "").match(/^(?:https?:\/\/[^/]+\/)?([^/\s]+)\/([^/\s#?]+)/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export function teamRoutes(app: AppContext): Hono {
  const r = new Hono();

  // ---------- GitHub sign-in ----------

  r.get("/github", (c) => c.json({ connection: app.github.status() ?? null }));

  r.post("/github/token", async (c) => {
    const b = z.object({ host: z.string().default("github.com"), token: z.string().min(10) }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "host and token are required" }, 400);
    try {
      return c.json({ connection: await app.github.connectWithToken(b.data.host, b.data.token) });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  r.post("/github/gh", async (c) => {
    const b = z.object({ host: z.string().default("github.com") }).safeParse(await c.req.json().catch(() => ({})));
    try {
      return c.json({ connection: await app.github.connectWithGhCli(b.success ? b.data.host : "github.com") });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  r.post("/github/device", async (c) => {
    const b = z.object({ host: z.string().default("github.com"), clientId: z.string().min(4) }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "clientId is required: the OAuth app your enterprise approved for Rig" }, 400);
    try {
      return c.json(await app.github.startDeviceFlow(b.data.host, b.data.clientId));
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  r.post("/github/device/poll", async (c) => {
    try {
      return c.json(await app.github.pollDeviceFlow());
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  r.delete("/github", async (c) => {
    await app.github.signOut();
    return c.json({ ok: true });
  });

  // ---------- team repo ----------

  r.get("/team", (c) => c.json(app.team.status()));

  r.put("/team", async (c) => {
    const b = z.object({ repo: z.string().min(3) }).safeParse(await c.req.json());
    const parsed = b.success ? parseRepo(b.data.repo) : undefined;
    if (!parsed) return c.json({ error: 'Give the repository as "owner/name" or its URL.' }, 400);
    try {
      return c.json(await app.team.connect(parsed.owner, parsed.repo));
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  r.delete("/team", (c) => {
    app.team.disconnect();
    return c.json({ ok: true });
  });

  r.post("/team/init", async (c) => {
    try {
      return c.json(await app.team.initialize());
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  r.post("/team/sync", async (c) => {
    try {
      const res = await app.team.sync();
      return c.json({ ...res, status: app.team.status() });
    } catch (e) {
      return c.json({ ...fail(e), status: app.team.status() }, 400);
    }
  });

  /**
   * Queues a personal agent or skill for the team. Agents must bind to an alias, which every
   * teammate maps to a model of their own; personal skills the agent uses travel with it.
   */
  r.post("/team/share", async (c) => {
    const b = z.object({ kind: z.enum(["agent", "skill"]), name: z.string().min(1) }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "kind and name are required" }, 400);
    if (!app.team.config()) return c.json({ error: "Connect a team repository first." }, 400);
    try {
      if (b.data.kind === "agent") {
        const def = app.agents.isLocal(b.data.name) ? app.agents.get(b.data.name) : undefined;
        if (!def) return c.json({ error: `No personal agent "${b.data.name}" to share.` }, 404);
        return c.json({ staged: stageAgent(app, def) });
      }
      return c.json({ staged: [stageSkill(app, b.data.name)] });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  /** Proposes an edit to a team agent. Nothing changes locally; the pull request is the change. */
  r.put("/team/agents/:slug", async (c) => {
    if (!app.team.config()) return c.json({ error: "Connect a team repository first." }, 400);
    const body = (await c.req.json()) as Record<string, unknown>;
    const v = validateAgentDefinition({ ...body, slug: c.req.param("slug") }, { knownSkills: app.skills.names() });
    if (!v.ok || !v.definition) return c.json(v, 400);
    try {
      return c.json({ ...v, staged: stageAgent(app, v.definition) });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  /** Proposes removing an agent, skill, or memory from the team repo. */
  r.post("/team/remove", async (c) => {
    const b = z.object({ kind: z.enum(["agent", "skill", "memory"]), name: z.string().min(1) }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "kind and name are required" }, 400);
    const { kind, name } = b.data;
    const exists = kind === "agent" ? app.agents.getTeam(name) : kind === "skill" ? app.skills.all().some((s) => s.name === name && s.source === "team") : app.memory.get(name, "team");
    if (!exists) return c.json({ error: `The team repo has no ${kind} named "${name}".` }, 404);
    return c.json({ staged: app.team.stage({ kind, name, op: "delete", files: {}, summary: `remove ${kind} "${name}"`, origin: "user" }) });
  });

  r.delete("/team/pending/:id", (c) => (app.team.unstage(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  r.post("/team/pull-request", async (c) => {
    const b = z.object({ ids: z.array(z.string()).optional(), title: z.string().optional(), body: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
    try {
      const pr = await app.team.openPullRequest(b.success ? b.data : {});
      return c.json({ pullRequest: pr, status: app.team.status() });
    } catch (e) {
      return c.json(fail(e), 400);
    }
  });

  return r;
}

function stageAgent(app: AppContext, def: AgentDefinition) {
  if (!("alias" in def.model)) {
    throw new Error(
      `"${def.slug}" is bound to a specific connection (${def.model.connection} / ${def.model.model}), which teammates do not have. Bind it to an alias such as "default" first; each person maps aliases to their own models.`,
    );
  }
  const team = app.agents.getTeam(def.slug);
  const shared: AgentDefinition = { ...def, version: team ? team.version + 1 : 1 };
  const staged = [
    app.team.stage({
      kind: "agent",
      name: def.slug,
      op: "upsert",
      files: { [`agents/${def.slug}.yaml`]: Buffer.from(agentToYaml(shared)).toString("base64") },
      summary: `${team ? "update" : "add"} agent "${def.name}"${def.description ? `: ${def.description}` : ""}`,
      origin: "user",
    }),
  ];
  // Personal skills the agent relies on would be missing for teammates; they go in the same pull request.
  for (const name of def.skills) {
    if (name === "*") continue;
    const skill = app.skills.get(name);
    if (skill && skill.source !== "team" && skill.source !== "bundled") staged.push(stageSkill(app, name));
  }
  return staged;
}

function stageSkill(app: AppContext, name: string) {
  const skill = app.skills.get(name);
  if (!skill) throw new Error(`No skill named "${name}".`);
  if (skill.source === "team") throw new Error(`"${name}" is already the team's. Edit it to propose a change.`);
  if (skill.source === "bundled") throw new Error(`"${name}" ships with Rig, so teammates already have it.`);
  return app.team.stage({
    kind: "skill",
    name,
    op: "upsert",
    files: TeamManager.skillFiles(name, skill.dir),
    summary: `share skill "${name}": ${skill.description}`,
    origin: "user",
  });
}
