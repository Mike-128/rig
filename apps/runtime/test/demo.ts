/**
 * A throwaway Rig for trying the UI without keys or spending money: the runtime on port 7790 (or
 * RIG_DEMO_PORT) against the mock model, in a fresh home folder, with a sample project to open.
 *
 *   pnpm --filter @rig/runtime demo
 *
 * The mock "model" picks tools from keywords in your message: read, edit, run, find, plan,
 * delegate, skill. Anything else gets an echo. Nothing here touches ~/.rig.
 *
 * `demo:fresh` (or RIG_DEMO_FRESH=1) starts it like a new install, with no provider connected, to try Settings > Setup.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayProfile } from "@rig/core";
import { startServer } from "../src/server";
import { serveWebUi } from "../src/web";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";
import { startMockGitHub } from "./mock-github";

const home = mkdtempSync(path.join(os.tmpdir(), "rig-demo-home-"));
const project = mkdtempSync(path.join(os.tmpdir(), "rig-demo-project-"));
writeFileSync(path.join(project, "hello.txt"), "hello from the demo project\n");
writeFileSync(path.join(project, "AGENTS.md"), "This is a demo project. Keep answers short.\n");
mkdirSync(path.join(project, "src"), { recursive: true });
writeFileSync(path.join(project, "src", "app.ts"), "export const answer = 42;\n");

const upstream = await startMockUpstream();
const profile: GatewayProfile = {
  id: "mock-gateway",
  displayName: "Mock gateway (demo)",
  baseUrl: upstream.url,
  auth: { headerName: "x-api-key" },
  models: [{ id: "mock-claude", displayName: "Mock Claude", dialect: "anthropic.messages", route: "/v1/messages", pricing: { input: 3, output: 15 }, capabilities: { maxContextTokens: 200_000 } }],
};
mkdirSync(path.join(home, "profiles"), { recursive: true });
writeFileSync(path.join(home, "profiles", "mock.json"), JSON.stringify(profile));

const port = Number(process.env.RIG_DEMO_PORT ?? 7790);
const github = await startMockGitHub({ tokens: { "demo-github-token": "you_demo" }, owner: "acme", repo: "rig-team", port: port + 2 });
const rt = await startServer({ home, port }, { fileSecrets: true, github: { apiBase: github.url } });
serveWebUi(rt.hono);
const api = (p: string, body: unknown, method = "POST") =>
  fetch(`http://127.0.0.1:${rt.port}/api${p}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const fresh = Boolean(process.env.RIG_DEMO_FRESH) || process.argv.includes("--fresh");
if (!fresh) {
  const conn = (await api("/connections", { name: "mock", profileId: "mock-gateway", key: GOOD_KEY })) as { connection: { id: string } };
  await api("/aliases/default", { connectionId: conn.connection.id, modelId: "mock-claude" }, "PUT");
  await api("/sessions", { agent: "coder", workspace: project, title: "Demo project" });
}

console.log(`\n  Rig demo on http://127.0.0.1:${rt.port}\n  home    ${home}\n  project ${project}\n`);
if (fresh) console.log(`  Fresh install: in Settings > Models choose "Mock gateway (demo)" and paste the key "${GOOD_KEY}".
`);
console.log("  Try: read hello.txt · edit it · run the tests · find files · plan this · delegate a search\n");
console.log('  Team (mock GitHub): in Settings, Team and GitHub, paste the token "demo-github-token" and connect "acme/rig-team".');
console.log(`  To act as the reviewing teammate: POST ${github.url}/__approve/<pr> or ${github.url}/__merge/<pr>\n`);
