import { Hono } from "hono";
import { resolveUpstream, type Dialect } from "@rig/core";
import type { AppContext } from "./context";
import { deploymentList } from "./deployment-list";

const HOP_BY_HOP = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "x-rig-proxy-token", "x-api-key", "authorization", "api-key", "ocp-apim-subscription-key"]);
const RESPONSE_STRIP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

/**
 * Loopback proxy. Presents standard provider-shaped endpoints per connection and rewrites
 * them onto the real gateway route, injecting the key. Engines never see credentials.
 *
 *   /proxy/:connectionId/anthropic/v1/messages        -> model route (dialect anthropic.messages)
 *   /proxy/:connectionId/anthropic/v1/models          -> profile listModels route
 *   /proxy/:connectionId/openai/v1/chat/completions   -> model route (dialect openai.chat)
 *   /proxy/:connectionId/openai/v1/models             -> profile listModels route
 */
export function proxyRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.all("/:connectionId/*", async (c) => {
    if (c.req.header("x-rig-proxy-token") !== app.config.proxyToken) return c.json({ error: "proxy token required" }, 401);
    const connectionId = c.req.param("connectionId");
    const conn = app.connections.get(connectionId);
    if (!conn) return c.json({ error: "unknown connection" }, 404);

    const sub = c.req.path.replace(/^\/proxy\/[^/]+/, "");
    const m = sub.match(/^\/(anthropic|openai)\/(.*)$/);
    if (!m) return c.json({ error: "unsupported proxy path" }, 404);
    const dialect: Dialect = m[1] === "anthropic" ? "anthropic.messages" : "openai.chat";
    const rest = "/" + m[2];

    const secret = await app.secrets.get(conn.id);
    if (!secret) return c.json({ error: "connection has no stored key" }, 500);

    const method = c.req.method.toUpperCase();
    const isList = rest === "/v1/models" && method === "GET";
    const isCall = (rest === "/v1/messages" || rest === "/v1/chat/completions") && method === "POST";
    if (!isList && !isCall) return c.json({ error: `unsupported proxy path ${rest}` }, 404);

    let url: string;
    let headers: Record<string, string>;
    let body: string | undefined;
    let deploymentInventory = false;

    if (isList) {
      const profile = app.profiles.get(conn.profileId);
      const spec = app.connections.discovery(conn.id) ?? profile?.listModels;
      if (!spec || spec.dialect !== dialect) return c.json({ error: "this connection's profile has no model listing route" }, 404);
      deploymentInventory = spec.responseFormat === "azure-deployments";
      const pseudo = { route: spec.route, query: undefined, bodyModel: "", dialect } as Parameters<typeof resolveUpstream>[1];
      const t = resolveUpstream(conn, pseudo, secret);
      url = t.url;
      const paged = new URL(url);
      const supplied = new URL(c.req.url).searchParams;
      for (const key of ["after", "before", "after_id", "before_id", "limit", "page", "page_size", "last_id"]) {
        const value = supplied.get(key);
        if (value !== null) paged.searchParams.set(key, value);
      }
      url = paged.toString();
      headers = t.headers;
    } else {
      const raw = await c.req.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const requested = String(parsed.model ?? "");
      const model = app.models.findByBodyModel(conn.id, requested);
      if (!model) return c.json({ error: `model "${requested}" is not registered on connection "${conn.name}"` }, 404);
      if (model.dialect !== dialect) return c.json({ error: `model "${requested}" speaks ${model.dialect}, not ${dialect}` }, 400);
      const t = resolveUpstream(conn, model, secret);
      url = t.url;
      headers = t.headers;
      parsed.model = t.bodyModel;
      body = JSON.stringify(parsed);
    }

    // Forward benign headers (content-type, accept, anthropic-version, anthropic-beta, user-agent), drop auth and hop-by-hop.
    const configured = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
    for (const [k, v] of Object.entries(c.req.header())) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (lk === conn.auth.headerName.toLowerCase()) continue;
      if (configured.has(lk)) continue;
      headers[k] = v;
    }
    if (body !== undefined) headers["content-type"] = "application/json";

    let upstream: Response;
    try {
      upstream = await fetch(url, { method, headers, body, signal: c.req.raw.signal, redirect: "manual" });
    } catch (e) {
      return c.json({ error: `upstream unreachable: ${(e as Error).message}` }, 502);
    }
    const outHeaders = new Headers();
    if (deploymentInventory && upstream.ok) {
      let payload: unknown;
      try { payload = await upstream.json(); }
      catch { return c.json({ error: { message: "Deployment inventory did not return valid JSON." } }, 422); }
      try { return c.json(deploymentList(payload)); }
      catch (e) { return c.json({ error: { message: (e as Error).message } }, 422); }
    }
    upstream.headers.forEach((v, k) => {
      if (!RESPONSE_STRIP.has(k.toLowerCase())) outHeaders.set(k, v);
    });
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  });

  return r;
}
