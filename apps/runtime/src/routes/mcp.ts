import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context";
import { EXAMPLE_CONFIG } from "../mcp";

export function mcpRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/", (c) =>
    c.json({
      configPath: app.mcp.configPath,
      config: app.mcp.readConfigText(),
      example: EXAMPLE_CONFIG,
      servers: app.mcp.status(),
    }),
  );

  /** Saves ~/.rig/mcp.json (validated first) and reconnects every server. */
  r.put("/", async (c) => {
    const b = z.object({ config: z.string() }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "config is required" }, 400);
    const res = app.mcp.writeConfig(b.data.config);
    if (!res.ok) return c.json({ error: res.error }, 400);
    await app.mcp.start();
    return c.json({ servers: app.mcp.status() });
  });

  r.post("/reload", async (c) => {
    await app.mcp.start();
    return c.json({ servers: app.mcp.status() });
  });

  return r;
}
