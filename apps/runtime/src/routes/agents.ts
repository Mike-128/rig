import { Hono } from "hono";
import { agentFromYaml, validateAgentDefinition } from "@rig/core";
import type { AppContext } from "../context";

export function agentRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/", (c) => c.json(app.agents.list()));

  r.post("/validate", async (c) => c.json(validateAgentDefinition(await c.req.json(), { knownSkills: app.skills.names() })));

  r.post("/import", async (c) => {
    const text = await c.req.text();
    let parsed: unknown;
    try {
      parsed = agentFromYaml(text);
    } catch (e) {
      return c.json({ ok: false, issues: [{ path: "", message: `YAML parse error: ${(e as Error).message}`, severity: "error" }] }, 400);
    }
    const res = app.agents.save(parsed, { knownSkills: app.skills.names() });
    return c.json(res, res.ok ? 200 : 400);
  });

  r.get("/:slug", (c) => {
    const def = app.agents.get(c.req.param("slug"));
    return def ? c.json(def) : c.json({ error: "not found" }, 404);
  });

  r.get("/:slug/export", (c) => {
    const y = app.agents.getYaml(c.req.param("slug"));
    if (!y) return c.json({ error: "not found" }, 404);
    c.header("content-type", "application/yaml; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${c.req.param("slug")}.yaml"`);
    return c.body(y);
  });

  r.put("/:slug", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    body.slug = c.req.param("slug");
    const res = app.agents.save(body, { knownSkills: app.skills.names() });
    return c.json(res, res.ok ? 200 : 400);
  });

  r.delete("/:slug", (c) => {
    app.agents.delete(c.req.param("slug"));
    return c.json({ ok: true });
  });

  return r;
}
