import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { startServer } from "./server";

const { app, hono } = await startServer();

// Serve the built web UI when present; otherwise explain how to get one instead of 404ing.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");
const webBuilt = existsSync(path.join(webDist, "index.html"));

if (webBuilt) {
  const root = path.relative(process.cwd(), webDist).split(path.sep).join("/") || ".";
  hono.use("/*", serveStatic({ root }));
  hono.get("*", serveStatic({ path: `${root}/index.html` }));
} else {
  hono.get("/", (c) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>Rig runtime</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e8ec;margin:0;padding:48px}
code{background:#1f232c;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace}
a{color:#5b9cff}.ok{color:#3ccf8e}h1{margin:0 0 8px}p{max-width:640px}</style>
<h1>Rig runtime</h1>
<p class="ok">The API is running. The web UI has not been built yet, which is why this page is not the app.</p>
<p>Either build the UI once and reload this page:</p>
<p><code>pnpm --filter @rig/web build</code></p>
<p>Or run the Vite dev server with hot reload and use it instead:</p>
<p><code>pnpm dev:web</code> then open <a href="http://localhost:5173">http://localhost:5173</a></p>
<p>API health: <a href="/api/health">/api/health</a></p>`,
    ),
  );
}

console.log(`[rig] runtime listening on ${app.config.proxyOrigin}`);
console.log(`[rig] home ${app.config.home}, secrets via ${app.secrets.backend}`);
if (app.secrets.backend !== "os-keychain") console.warn("[rig] OS keychain unavailable; keys are stored in encrypted files under RIG_HOME/secrets");
console.log(webBuilt ? "[rig] serving the web UI at /" : "[rig] web UI not built; open / for instructions, or run `pnpm dev:web`");
