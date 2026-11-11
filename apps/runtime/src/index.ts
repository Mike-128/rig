import { startServer } from "./server";
import { serveWebUi } from "./web";

const { app, hono } = await startServer();
const webBuilt = serveWebUi(hono);

console.log(`[rig] runtime listening on ${app.config.proxyOrigin}`);
console.log(`[rig] home ${app.config.home}, secrets via ${app.secrets.backend}`);
if (app.secrets.backend !== "os-keychain") console.warn("[rig] OS keychain unavailable; keys are stored in encrypted files under RIG_HOME/secrets");
console.log(webBuilt ? "[rig] serving the web UI at /" : "[rig] web UI not built; open / for instructions, or run `pnpm dev:web`");
