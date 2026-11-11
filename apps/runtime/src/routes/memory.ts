import { Hono } from "hono";
import { z } from "zod";
import { MEMORY_TYPES, renderMemory, validateMemoryInput, type MemoryType } from "@rig/core";
import type { AppContext } from "../context";
import { today } from "../stores/memory";

const Input = z.object({
  description: z.string(),
  type: z.enum(MEMORY_TYPES as unknown as [MemoryType, ...MemoryType[]]).default("fact"),
  body: z.string(),
});

export function memoryRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const proposed = app.team
      .pending()
      .filter((p) => p.kind === "memory")
      .map((p) => ({ name: p.name, op: p.op }));
    return c.json({ memories: app.memory.all(), proposed, teamConnected: Boolean(app.team.config()) });
  });

  r.put("/personal/:name", async (c) => {
    const b = Input.safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "description, type, and body are required" }, 400);
    const res = app.memory.writePersonal({ name: c.req.param("name"), ...b.data }, app.github.status()?.login);
    return res.ok ? c.json({ ok: true }) : c.json({ error: res.error }, 400);
  });

  r.delete("/personal/:name", (c) => (app.memory.deletePersonal(c.req.param("name")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  /** Proposes a team memory (new, edited, or a personal one promoted). It takes effect when the pull request merges. */
  r.put("/team/:name", async (c) => {
    if (!app.team.config()) return c.json({ error: "Connect a team repository first." }, 400);
    const b = Input.safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "description, type, and body are required" }, 400);
    const input = { name: c.req.param("name"), ...b.data };
    const err = validateMemoryInput(input);
    if (err) return c.json({ error: err }, 400);
    const text = renderMemory({ ...input, author: app.github.status()?.login, updated: today() });
    try {
      const staged = app.team.stage({
        kind: "memory",
        name: input.name,
        op: "upsert",
        files: { [`memory/${input.name}.md`]: Buffer.from(text).toString("base64") },
        summary: input.description,
        origin: "user",
      });
      return c.json({ staged });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  return r;
}
