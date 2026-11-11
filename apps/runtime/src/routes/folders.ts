import { Hono } from "hono";
import { opendir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** User-driven workspace selection; this does not grant an agent access to a folder. */
export function folderRoutes(): Hono {
  const r = new Hono();
  r.get("/folders", async (c) => {
    const requested = c.req.query("path") || os.homedir();
    if (!path.isAbsolute(requested)) return c.json({ error: "Choose an absolute folder path" }, 400);
    try {
      const current = await realpath(requested);
      const entries: { name: string; path: string }[] = [];
      let examined = 0;
      let truncated = false;
      const dir = await opendir(current);
      for await (const entry of dir) {
        if (++examined > 2000 || entries.length >= 500) { truncated = true; break; }
        // Do not traverse links/junctions implicitly in the picker.
        if (entry.isDirectory() && !entry.isSymbolicLink()) entries.push({ name: entry.name, path: path.join(current, entry.name) });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(current);
      return c.json({ path: current, parent: parent === current ? null : parent, entries, truncated });
    } catch {
      return c.json({ error: "Cannot browse this folder. Check that it exists and the Rig account can read it." }, 400);
    }
  });
  return r;
}
