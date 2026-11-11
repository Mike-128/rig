import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");

/** Serve the built web UI when present; otherwise explain how to get one instead of 404ing. Returns whether it is built. */
export function serveWebUi(hono: Hono): boolean {
  const built = existsSync(path.join(webDist, "index.html"));
  if (built) {
    const root = path.relative(process.cwd(), webDist).split(path.sep).join("/") || ".";
    hono.use("/*", serveStatic({ root }));
    hono.get("*", serveStatic({ path: `${root}/index.html` }));
    return true;
  }
  hono.get("/", (c) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>Rig runtime</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e8ec;margin:0;padding:48px}
code{background:#1f232c;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace}
a{color:#5b9cff}.ok{color:#3ccf8e}h1{margin:0 0 8px}p{max-width:640px}</style>
<h1>Rig runtime</h1>
<p class="ok">The API is running. The web UI has not been built yet, which is why this page is not the app.</p>
<p>In a second terminal at the repository root, build the UI:</p>
<p><code>pnpm build</code> (Windows: <code>pnpm.cmd build</code>)</p>
<p>Wait for the build to finish. Stop the runtime with Ctrl+C, start it again with <code>pnpm rig serve</code> (Windows: <code>pnpm.cmd rig serve</code>), then reload this page. The runtime checks for the UI at startup.</p>
<p>Or run the Vite dev server with hot reload and use it instead:</p>
<p><code>pnpm dev:web</code> then open <a href="http://localhost:5173">http://localhost:5173</a></p>
<p>Keep both the runtime and Vite terminals running when using the development UI. On Windows use <code>pnpm.cmd dev:web</code>.</p>
<p>Once the app opens, Settings &rarr; Setup walks you through connecting a provider and its key.</p>
<p>API health: <a href="/api/health">/api/health</a></p>`,
    ),
  );
  return false;
}
