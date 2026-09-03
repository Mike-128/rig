import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context";

const WriteSkill = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
});

export function skillRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/", (c) => c.json({ skills: app.skills.list(), problems: app.skills.problems() }));

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
