import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context";
import { GitHubSkillSource } from "../github-skills";

const github = new GitHubSkillSource();

const WriteSkill = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
});

export function skillRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const ws = c.req.query("workspace") || undefined;
    return c.json({ skills: app.skills.list(ws), problems: app.skills.problems(ws) });
  });

  /** Lists the skills in a GitHub repository or folder before installing. */
  r.post("/github/preview", async (c) => {
    const b = z.object({ source: z.string().min(1) }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "source is required" }, 400);
    try {
      const preview = await github.preview(b.data.source);
      const installed = new Set(app.skills.names());
      return c.json({ ...preview, skills: preview.skills.map((s) => ({ ...s, installed: installed.has(s.name) })) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Installs skills from GitHub into ~/.rig/skills. Omitting names installs every skill found. */
  r.post("/github/install", async (c) => {
    const b = z.object({ source: z.string().min(1), names: z.array(z.string()).optional() }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "source is required" }, 400);
    try {
      const { preview, skills } = await github.fetchSkills(b.data.source, b.data.names);
      return c.json(app.skills.installFetched(skills, { repo: preview.repo, ref: preview.ref, sha: preview.sha }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Re-installs a GitHub skill from where it came from, picking up upstream changes. */
  r.post("/:name/update", async (c) => {
    const s = app.skills.get(c.req.param("name"));
    if (!s?.origin) return c.json({ error: "this skill was not installed from GitHub" }, 400);
    try {
      const source = `https://github.com/${s.origin.repo}/tree/${s.origin.ref}/${s.origin.path}`;
      const { preview, skills } = await github.fetchSkills(source, [s.name]);
      const res = app.skills.installFetched(skills, { repo: preview.repo, ref: preview.ref, sha: preview.sha });
      return c.json({ ...res, previousSha: s.origin.sha, sha: preview.sha });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  r.get("/:name", (c) => {
    const s = app.skills.get(c.req.param("name"));
    return s ? c.json(s) : c.json({ error: "not found" }, 404);
  });

  r.put("/:name", async (c) => {
    const parsed = WriteSkill.safeParse({ ...(await c.req.json()), name: c.req.param("name") });
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const { name, description, body } = parsed.data;
    const res = app.skills.write(name, description, body);
    return res.ok ? c.json({ ok: true, hash: res.hash }) : c.json({ error: res.error }, 400);
  });

  r.post("/import", async (c) => {
    const res = app.skills.importMarkdown(await c.req.text());
    return res.ok ? c.json(res) : c.json({ error: res.error }, 400);
  });

  r.delete("/:name", (c) => {
    const res = app.skills.delete(c.req.param("name"));
    return res.ok ? c.json({ ok: true }) : c.json({ error: res.error }, 400);
  });

  return r;
}
