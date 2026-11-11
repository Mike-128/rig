import { Command, InvalidArgumentError } from "commander";
import { readFileSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentSummary, Connection, GatewayProfile, Model, ModelAlias, Session } from "@rig/core";
import { agentFromYaml } from "@rig/core";
import { api, sse, BASE } from "./client";
import { c, makeRenderer } from "./render";
import { runDoctor } from "./doctor";

const program = new Command().name("rig").description("Provider-agnostic agent rig").version("0.1.0");

program.command("doctor")
  .description("Check ordinary-user setup and runtime health; provider calls require --probe")
  .option("--offline", "only check this machine; no runtime or provider HTTP calls")
  .option("--probe", "probe the default model through the runtime (may incur usage; updates saved entitlement)")
  .option("--json", "print a structured diagnostic report")
  .option("--workspace <dir>", "workspace to test using temporary files", process.env.INIT_CWD ?? process.cwd())
  .option("--timeout <seconds>", "shell and runtime request timeout (probe has a 35-second minimum)", (value: string) => {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new InvalidArgumentError("Expected an integer from 1 to 120.");
    return seconds;
  }, 5)
  .action(async (opts: { offline?: boolean; probe?: boolean; json?: boolean; workspace: string; timeout: number }) => {
    if (opts.offline && opts.probe) throw new Error("--offline and --probe cannot be combined");
    const report = await runDoctor({ ...opts, timeoutMs: opts.timeout * 1000, baseUrl: BASE });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const check of report.checks) console.log(`${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.message}`);
      console.log(`\n${report.exitCode ? "Required checks failed." : "No required checks failed."} Warnings identify unverified or optional capabilities.`);
    }
    process.exitCode = report.exitCode;
  });

// ---- serve ----------------------------------------------------------------
program
  .command("serve")
  .description("Start the local runtime (API, loopback proxy, and the built web UI if present)")
  .action(async () => {
    await import("@rig/runtime/serve");
  });

// ---- models ---------------------------------------------------------------
const models = program.command("models").description("Gateway profiles, connections, and the model catalog");

models
  .command("profiles")
  .description("List gateway profiles")
  .action(async () => {
    for (const p of await api<GatewayProfile[]>("/profiles")) {
      console.log(`${p.id.padEnd(20)} ${p.displayName}${p.template ? c.dim("  (template: edit base URL)") : ""}`);
      console.log(c.dim(`${"".padEnd(20)} ${p.baseUrl} · ${p.auth.headerName} · ${p.models.length} catalog models`));
    }
  });

models
  .command("list")
  .description("List registered models and their entitlement status")
  .action(async () => {
    const rows = await api<(Model & { connectionName: string })[]>("/models");
    const aliases = await api<ModelAlias[]>("/aliases");
    if (!rows.length) return console.log("No models. Add a connection first: rig connections add --help");
    for (const m of rows) {
      const al = aliases.filter((a) => a.connectionId === m.connectionId && a.modelId === m.providerModelId).map((a) => `@${a.alias}`).join(" ");
      const status = m.status === "entitled" ? c.green(m.status) : m.status === "unprobed" || m.status === "listed" ? c.dim(m.status) : c.red(m.status);
      console.log(`${m.connectionName.padEnd(16)} ${m.providerModelId.padEnd(32)} ${m.dialect.padEnd(20)} ${status} ${c.dim(m.statusMessage ?? "")} ${c.yellow(al)}`);
    }
  });

models
  .command("probe <connection>")
  .description("List (where supported) and probe a connection's catalog models")
  .option("--include-listed", "also probe models discovered by listing")
  .action(async (connName: string, opts: { includeListed?: boolean }) => {
    const conn = await findConnection(connName);
    const res = await api<{ models: Model[]; listed: number; listError?: string }>(`/connections/${conn.id}/probe?includeListed=${opts.includeListed ? "true" : "false"}`, { method: "POST" });
    for (const m of res.models) {
      const status = m.status === "entitled" ? c.green(m.status) : m.status === "listed" ? c.dim(m.status) : c.red(m.status);
      console.log(`${m.providerModelId.padEnd(32)} ${status} ${c.dim(m.statusMessage ?? "")}`);
    }
    if (res.listed) console.log(c.dim(`${res.listed} additional model(s) listed by the provider; probe with --include-listed or individually.`));
    if (res.listError) console.log(c.yellow(`listing failed: ${res.listError}`));
  });

// ---- connections ----------------------------------------------------------
const connections = program.command("connections").description("Manage keyed connections");

connections
  .command("list")
  .action(async () => {
    for (const x of await api<Connection[]>("/connections")) console.log(`${x.name.padEnd(16)} ${x.profileId.padEnd(18)} ${x.baseUrl} ${c.dim(`${x.auth.headerName} …${x.secretLast4}`)}`);
  });

connections
  .command("add")
  .description("Add a connection. The key is read from --key-env, --key-stdin, or a hidden prompt; it is stored in the OS keychain.")
  .requiredOption("--name <name>", "connection name")
  .requiredOption("--profile <id>", "gateway profile id (see: rig models profiles)")
  .option("--key-env <VAR>", "environment variable holding the key")
  .option("--key-stdin", "read the key from stdin")
  .option("--base-url <url>", "override the profile base URL")
  .option("--header <name>", "override the auth header name")
  .option("--no-probe", "skip probing after adding")
  .action(async (opts: { name: string; profile: string; keyEnv?: string; keyStdin?: boolean; baseUrl?: string; header?: string; probe: boolean }) => {
    let key: string | undefined;
    if (opts.keyEnv) key = process.env[opts.keyEnv];
    else if (opts.keyStdin) key = readFileSync(0, "utf8").trim();
    else key = await hiddenPrompt("Key: ");
    if (!key) throw new Error("no key provided");
    const res = await api<{ connection: Connection; models: Model[] }>("/connections", {
      method: "POST",
      json: { name: opts.name, profileId: opts.profile, key, baseUrl: opts.baseUrl, headerName: opts.header },
    });
    console.log(`Added ${res.connection.name} (${res.models.length} catalog models)`);
    if (opts.probe) await program.parseAsync(["models", "probe", res.connection.name], { from: "user" });
  });

connections
  .command("remove <name>")
  .action(async (name: string) => {
    const conn = await findConnection(name);
    await api(`/connections/${conn.id}`, { method: "DELETE" });
    console.log("removed");
  });

// ---- alias ----------------------------------------------------------------
const alias = program.command("alias").description("Bind aliases (e.g. default, fast, smart) to models");
alias
  .command("set <alias> <connection> <model>")
  .action(async (a: string, connName: string, model: string) => {
    const conn = await findConnection(connName);
    await api(`/aliases/${encodeURIComponent(a)}`, { method: "PUT", json: { connectionId: conn.id, modelId: model } });
    console.log(`${a} -> ${conn.name}/${model}`);
  });
alias.command("list").action(async () => {
  for (const x of await api<ModelAlias[]>("/aliases")) console.log(`${x.alias.padEnd(12)} ${x.connectionId}/${x.modelId}`);
});

// ---- agent ----------------------------------------------------------------
const agent = program.command("agent").description("Create, inspect, and run agents");

agent.command("list").action(async () => {
  for (const a of await api<AgentSummary[]>("/agents")) console.log(`${a.slug.padEnd(20)} v${String(a.version).padEnd(3)} ${a.name} ${c.dim(a.description ?? "")}`);
});

agent
  .command("show <slug>")
  .action(async (slug: string) => {
    const res = await fetch(`${BASE}/api/agents/${slug}/export`);
    if (!res.ok) throw new Error(`agent ${slug} not found`);
    process.stdout.write(await res.text());
  });

agent
  .command("create <file>")
  .description("Create or update an agent from a YAML file (the slug in the file is used)")
  .action(async (file: string) => {
    const text = readFileSync(file, "utf8");
    agentFromYaml(text); // parse locally first for a clearer error
    const res = await api<{ ok: boolean; issues: { path: string; message: string; severity: string }[]; saved?: { slug: string; version: number } }>("/agents/import", {
      method: "POST",
      body: text,
      headers: { "content-type": "application/yaml" },
    });
    for (const i of res.issues) console.log((i.severity === "error" ? c.red : c.yellow)(`${i.severity}: ${i.path ? i.path + ": " : ""}${i.message}`));
    if (res.saved) console.log(`Saved ${res.saved.slug} v${res.saved.version}`);
  });

agent
  .command("run <slug> <input>")
  .description("Run an agent for one turn (new session unless --session is given) and stream the result")
  .option("--session <id>", "continue an existing session")
  .option("--workspace <dir>", "workspace directory for a new session")
  .option("--reasoning", "show reasoning deltas")
  .option("--yes", "auto-approve tool calls that require approval")
  .action(async (slug: string, input: string, opts: { session?: string; workspace?: string; reasoning?: boolean; yes?: boolean }) => {
    const session = opts.session ? await api<{ session: Session }>(`/sessions/${opts.session}`).then((d) => d.session) : await api<Session>("/sessions", { method: "POST", json: { agent: slug, workspace: opts.workspace } });
    console.log(c.dim(`session ${session.id} · workspace ${session.workspace}`));
    await runTurn(session, input, { reasoning: opts.reasoning, autoApprove: opts.yes });
  });

// ---- chat -----------------------------------------------------------------
program
  .command("chat")
  .description("Interactive chat with an agent")
  .option("--agent <slug>", "agent to chat with", "assistant")
  .option("--session <id>", "resume a session")
  .option("--workspace <dir>", "workspace directory")
  .option("--reasoning", "show reasoning deltas")
  .action(async (opts: { agent: string; session?: string; workspace?: string; reasoning?: boolean }) => {
    const session = opts.session ? await api<{ session: Session }>(`/sessions/${opts.session}`).then((d) => d.session) : await api<Session>("/sessions", { method: "POST", json: { agent: opts.agent, workspace: opts.workspace } });
    console.log(c.dim(`session ${session.id} · agent ${session.agentSlug} v${session.agentVersion} · workspace ${session.workspace}`));
    console.log(c.dim("type a message; /quit to exit"));
    const rl = readline.createInterface({ input: stdin, output: stdout });
    while (true) {
      const line = (await rl.question(c.green("you> "))).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      await runTurn(session, line, { reasoning: opts.reasoning, rl });
    }
    rl.close();
  });

// ---- helpers --------------------------------------------------------------
async function findConnection(nameOrId: string): Promise<Connection> {
  const all = await api<Connection[]>("/connections");
  const conn = all.find((x) => x.name === nameOrId || x.id === nameOrId);
  if (!conn) throw new Error(`connection "${nameOrId}" not found (have: ${all.map((x) => x.name).join(", ") || "none"})`);
  return conn;
}

async function hiddenPrompt(label: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const muted = { write: (s: string) => (s.includes("\n") ? stdout.write("\n") : undefined) };
  process.stdout.write(label);
  const orig = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => muted.write(s);
  const v = await rl.question("");
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = orig;
  rl.close();
  return v.trim();
}

async function runTurn(session: Session, input: string, opts: { reasoning?: boolean; autoApprove?: boolean; rl?: readline.Interface }): Promise<void> {
  const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input } });
  const r = makeRenderer({ showReasoning: opts.reasoning });
  const controller = new AbortController();
  let pendingPrompt: Promise<void> | undefined;
  await sse(
    `/runs/${run.id}/events`,
    (ev) => {
      const cont = r.handle(ev);
      const p = r.pending();
      if (p && !pendingPrompt) {
        pendingPrompt = (async () => {
          let decision: "approve" | "deny" = "deny";
          if (opts.autoApprove) decision = "approve";
          else {
            const rl = opts.rl ?? readline.createInterface({ input: stdin, output: stdout });
            const ans = (await rl.question(c.yellow("approve? [y/N] "))).trim().toLowerCase();
            if (!opts.rl) rl.close();
            decision = ans === "y" || ans === "yes" ? "approve" : "deny";
          }
          await api(`/runs/${p.runId}/approvals/${p.callId}`, { method: "POST", json: { decision } });
          pendingPrompt = undefined;
        })();
      }
      return cont;
    },
    controller.signal,
  );
}

program.parseAsync(process.argv).catch((e) => {
  console.error(c.red((e as Error).message));
  process.exit(1);
});
