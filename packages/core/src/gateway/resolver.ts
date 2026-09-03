import type { Connection, Model } from "../types/model";

/** What the proxy sends upstream for one model call. */
export interface UpstreamTarget {
  url: string;
  headers: Record<string, string>;
  bodyModel: string;
}

/**
 * Build the upstream URL and headers for a model behind a connection.
 * `secret` is the decrypted key; only the proxy ever calls this with a real one.
 */
export function resolveUpstream(conn: Connection, model: Model, secret: string, route?: string, query?: Record<string, string>): UpstreamTarget {
  const base = conn.baseUrl.replace(/\/+$/, "");
  const path = (route ?? model.route).startsWith("/") ? (route ?? model.route) : `/${route ?? model.route}`;
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? model.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...(conn.extraHeaders ?? {}) };
  headers[conn.auth.headerName] = `${conn.auth.prefix ?? ""}${secret}`;
  return { url: url.toString(), headers, bodyModel: model.bodyModel };
}

/** Where an engine's SDK client points: the loopback proxy, scoped to a connection and dialect. */
export function proxyBaseUrl(proxyOrigin: string, connectionId: string, dialect: Model["dialect"]): string {
  const seg = dialect === "anthropic.messages" ? "anthropic" : "openai";
  const base = `${proxyOrigin.replace(/\/+$/, "")}/proxy/${encodeURIComponent(connectionId)}/${seg}`;
  // The OpenAI SDK expects the base URL to include /v1; the Anthropic SDK appends /v1 itself.
  return dialect === "openai.chat" ? `${base}/v1` : base;
}
