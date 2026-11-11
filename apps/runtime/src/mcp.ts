import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResult, ToolSpec } from "@rig/core";
import { z } from "zod";

/**
 * MCP servers as tool sources. Configuration uses the "mcpServers" shape Claude Code and other MCP
 * clients use, so an existing server definition can be pasted in unchanged. It lives in
 * ~/.rig/mcp.json only: a repository's own .mcp.json can run arbitrary commands, so it is not read
 * without the user putting it here.
 *
 * Tools are exposed as mcp__<server>__<tool>. An agent opts in by listing them, or mcp__<server>__*
 * for a whole server, or mcp__* for every server. Tools are treated as side-effecting (and so
 * approval-gated) unless the server marks them read-only.
 */

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

const Stdio = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  disabled: z.boolean().optional(),
});
const Remote = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
});
export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string().regex(NAME, "server names are letters, digits, _ and -"), z.union([Remote, Stdio])).default({}),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;
type ServerConfig = McpConfig["mcpServers"][string];

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http" | "sse";
  status: "connecting" | "connected" | "failed" | "disabled";
  error?: string;
  tools: { name: string; fullName: string; description: string; readOnly: boolean }[];
}

interface Server {
  status: McpServerStatus;
  client?: Client;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 50_000;

/** ${VAR} and ${VAR:-default} expand from the runtime's environment, as in Claude Code's config. */
function expand(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, v: string, d?: string) => process.env[v] ?? d ?? "");
}

/** Provider tool names allow letters, digits, _ and - up to 64 characters. */
function toolName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

export const EXAMPLE_CONFIG = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/path/to/allowed/folder"]
    },
    "remote-example": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer \${EXAMPLE_TOKEN}" }
    }
  }
}
`;

export class McpManager {
  private servers = new Map<string, Server>();
  private generation = 0;

  constructor(private home: string) {}

  get configPath(): string {
    return path.join(this.home, "mcp.json");
  }

  readConfigText(): string {
    return existsSync(this.configPath) ? readFileSync(this.configPath, "utf8") : "";
  }

  /** Validates before writing, so a typo never takes the running servers down. */
  writeConfig(text: string): { ok: true } | { ok: false; error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
    }
    const r = McpConfigSchema.safeParse(parsed);
    if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    writeFileSync(this.configPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    return { ok: true };
  }

  private readConfig(): McpConfig {
    const text = this.readConfigText();
    if (!text.trim()) return { mcpServers: {} };
    const r = McpConfigSchema.safeParse(JSON.parse(text));
    if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  }

  /** (Re)connects every configured server. Resolves when all have connected or failed. */
  async start(): Promise<void> {
    await this.close();
    const gen = ++this.generation;
    let config: McpConfig;
    try {
      config = this.readConfig();
    } catch (e) {
      console.warn(`[rig] ${this.configPath} is invalid: ${(e as Error).message}`);
      return;
    }
    await Promise.all(Object.entries(config.mcpServers).map(([name, cfg]) => this.connect(gen, name, cfg)));
  }

  private async connect(gen: number, name: string, cfg: ServerConfig): Promise<void> {
    const transportKind = "url" in cfg ? cfg.type : "stdio";
    const server: Server = { status: { name, transport: transportKind, status: cfg.disabled ? "disabled" : "connecting", tools: [] } };
    this.servers.set(name, server);
    if (cfg.disabled) return;

    let stderr = "";
    const client = new Client({ name: "rig", version: "0.3.0" });
    try {
      let transport;
      if ("url" in cfg) {
        const url = new URL(expand(cfg.url));
        const headers = Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, expand(v)]));
        transport = cfg.type === "sse" ? new SSEClientTransport(url, { requestInit: { headers } }) : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
      } else {
        const stdio = new StdioClientTransport({
          command: expand(cfg.command),
          args: cfg.args.map(expand),
          env: { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, expand(v)])) },
          cwd: cfg.cwd ? expand(cfg.cwd) : undefined,
          stderr: "pipe",
        });
        stdio.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
        transport = stdio;
      }
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connecting");
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "listing tools");
      if (gen !== this.generation) {
        await client.close().catch(() => {});
        return;
      }
      server.client = client;
      server.status.status = "connected";
      server.status.tools = listed.tools.map((t) => ({
        name: t.name,
        fullName: toolName(name, t.name),
        description: t.description ?? "",
        readOnly: t.annotations?.readOnlyHint === true,
      }));
      client.onclose = () => {
        if (server.client === client) {
          server.status.status = "failed";
          server.status.error = `Disconnected.${stderr ? ` ${stderr.trim().slice(-500)}` : ""}`;
          server.client = undefined;
        }
      };
      // Keep the schemas for building tool specs.
      this.schemas.set(name, new Map(listed.tools.map((t) => [t.name, t.inputSchema as Record<string, unknown>])));
    } catch (e) {
      await client.close().catch(() => {});
      server.status.status = "failed";
      server.status.error = `${(e as Error).message}${stderr ? `\n${stderr.trim().slice(-800)}` : ""}`;
    }
  }

  private schemas = new Map<string, Map<string, Record<string, unknown>>>();

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => s.status);
  }

  /** Tool specs for every connected server, read fresh on each run so reconnects take effect. */
  tools(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const [serverName, server] of this.servers) {
      const client = server.client;
      if (!client) continue;
      for (const t of server.status.tools) {
        out.push({
          definition: {
            name: t.fullName,
            description: `[MCP server "${serverName}"] ${t.description}`.slice(0, 1024),
            inputSchema: this.schemas.get(serverName)?.get(t.name) ?? { type: "object", properties: {} },
          },
          sideEffect: !t.readOnly,
          minSandbox: t.readOnly ? 0 : 1,
          run: (input, ctx) => callTool(client, t.name, input, ctx.signal),
        });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    const clients = [...this.servers.values()].map((s) => s.client).filter((c): c is Client => Boolean(c));
    this.servers.clear();
    this.schemas.clear();
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }
}

async function callTool(client: Client, name: string, input: unknown, signal: AbortSignal): Promise<ToolResult> {
  try {
    const res = await client.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
    const parts: string[] = [];
    for (const c of (res.content ?? []) as { type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[]) {
      if (c.type === "text") parts.push(c.text ?? "");
      else if (c.type === "resource") parts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`);
      else parts.push(`[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""} omitted]`);
    }
    if (!parts.length && res.structuredContent) parts.push(JSON.stringify(res.structuredContent, null, 2));
    let output = parts.join("\n") || "(no output)";
    if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n[truncated]`;
    return { output, isError: res.isError === true };
  } catch (e) {
    return { output: `MCP call failed: ${(e as Error).message}`, isError: true };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out ${what} after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
