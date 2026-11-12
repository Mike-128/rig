import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_CAPABILITIES, type Connection, type Dialect, type Model } from "@rig/core";
import type { AppContext } from "../context";
import { discoverListed, ensureDefaultAlias, entryToModel, probeConnection, probeModel, seedFromProfile } from "../catalog";
import { newId } from "../ids";
import { AuthHeaderName, AuthPrefix, DiscoverySpec, ExtraHeaders } from "../connection-settings";

/** Fix a connection in place: endpoint, how the key is sent, extra headers, and optionally the key. */
const EditConnection = z
  .object({
    baseUrl: z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), { message: "The base URL must start with http:// or https://" }),
    headerName: AuthHeaderName,
    headerPrefix: AuthPrefix,
    extraHeaders: ExtraHeaders,
    key: z.string().trim().min(1),
  })
  .partial()
  .strict();

const ManualModel = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  dialect: z.enum(["anthropic.messages", "openai.chat"]),
  route: z.string().trim().min(1),
  query: z.record(z.string(), z.string()).optional(),
  bodyModel: z.string().optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  reasoning: z.boolean().optional(),
  pricing: z.object({ input: z.number(), output: z.number(), cachedInput: z.number().optional() }).optional(),
});

const CreateConnection = z.object({
  name: z.string().min(1).max(60),
  profileId: z.string().min(1),
  key: z.string().min(1),
  baseUrl: z.string().url().optional(),
  headerName: z.string().min(1).optional(),
  headerPrefix: z.string().optional(),
  extraHeaders: ExtraHeaders.optional(),
  kind: z.enum(["direct", "gateway", "local"]).optional(),
  /** Models to add with the connection, for gateways whose routes cannot be discovered. */
  models: z.array(ManualModel).max(20).optional(),
});

const ReplaceKey = z.object({ key: z.string().trim().min(1) });

const EditManualModel = ManualModel.omit({ id: true, pricing: true }).partial().strict();

function manualModel(conn: Connection, b: z.infer<typeof ManualModel>): Model {
  return entryToModel(
    conn,
    {
      id: b.id,
      displayName: b.displayName,
      dialect: b.dialect as Dialect,
      route: b.route,
      query: b.query,
      bodyModel: b.bodyModel,
      capabilities: { ...DEFAULT_CAPABILITIES, reasoning: b.reasoning ?? false },
      pricing: b.pricing ? { ...b.pricing, source: "estimate" } : undefined,
      params: b.maxTokensField ? { maxTokensField: b.maxTokensField } : undefined,
    },
    "manual",
  );
}

export function catalogRoutes(app: AppContext): Hono {
  const r = new Hono();

  r.get("/profiles", (c) => c.json(app.profiles.list()));

  r.get("/connections", (c) => c.json(app.connections.list()));

  r.post("/connections", async (c) => {
    const parsed = CreateConnection.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const b = parsed.data;
    const profile = app.profiles.get(b.profileId);
    if (!profile) return c.json({ error: `unknown profile ${b.profileId}` }, 400);
    const headers = ExtraHeaders.safeParse({ ...profile.extraHeaders, ...b.extraHeaders });
    if (!headers.success || Object.keys(headers.data).includes((b.headerName ?? profile.auth.headerName).toLowerCase())) return c.json({ error: "Invalid extra headers; use the Key field for authentication" }, 400);
    if (app.connections.getByName(b.name)) return c.json({ error: `connection "${b.name}" already exists` }, 409);
    const id = newId("conn");
    await app.secrets.set(id, b.key);
    const kind = b.kind ?? (profile.id.includes("apim") || profile.id.includes("gateway") ? "gateway" : profile.baseUrl.includes("localhost") ? "local" : "direct");
    const conn = app.connections.create({
      id,
      name: b.name,
      profileId: profile.id,
      kind,
      baseUrl: b.baseUrl ?? profile.baseUrl,
      auth: { headerName: b.headerName ?? profile.auth.headerName, prefix: b.headerPrefix ?? profile.auth.prefix },
      extraHeaders: headers.data,
      secretLast4: b.key.slice(-4),
    });
    // A template's catalog holds example routes; when the user named their own models, those are the real ones.
    const seeded = profile.template && b.models?.length ? [] : seedFromProfile(app, conn, profile);
    const added = (b.models ?? []).map((m) => app.models.upsert(manualModel(conn, m)));
    return c.json({ connection: conn, models: [...seeded, ...added] }, 201);
  });

  r.delete("/connections/:id", async (c) => {
    const id = c.req.param("id");
    if (!app.connections.get(id)) return c.json({ error: "not found" }, 404);
    await app.secrets.delete(id);
    app.connections.delete(id);
    return c.json({ ok: true });
  });

  /**
   * Edit a connection without re-adding it. The name stays fixed because agents refer to it.
   * Any change clears earlier test results, which were for the old settings.
   */
  r.patch("/connections/:id", async (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    const parsed = EditConnection.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body", issues: parsed.error.issues }, 400);
    const b = parsed.data;
    const baseUrl = b.baseUrl === undefined ? conn.baseUrl : b.baseUrl.replace(/\/+$/, "");
    const auth = { headerName: b.headerName ?? conn.auth.headerName, prefix: b.headerPrefix === undefined ? conn.auth.prefix : b.headerPrefix || undefined };
    const headers = b.extraHeaders ?? conn.extraHeaders ?? {};
    if (Object.keys(headers).includes(auth.headerName.toLowerCase())) return c.json({ error: "An additional header uses the same name as the key header; the key belongs in the Key field." }, 400);
    if (b.key !== undefined) {
      await app.secrets.set(conn.id, b.key);
      app.connections.setSecretLast4(conn.id, b.key.slice(-4));
    }
    if (baseUrl !== conn.baseUrl || auth.headerName !== conn.auth.headerName || auth.prefix !== conn.auth.prefix) app.connections.setEndpoint(conn.id, baseUrl, auth);
    if (b.extraHeaders !== undefined) app.connections.setHeaders(conn.id, headers);
    return c.json(app.connections.get(conn.id));
  });

  /** Replace the key, for a rotated or switched key. Models, aliases, and settings stay as they are. */
  r.put("/connections/:id/key", async (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    const parsed = ReplaceKey.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "A key is required" }, 400);
    await app.secrets.set(conn.id, parsed.data.key);
    app.connections.setSecretLast4(conn.id, parsed.data.key.slice(-4));
    return c.json(app.connections.get(conn.id));
  });

  r.patch("/connections/:id/headers", async (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    const parsed = ExtraHeaders.safeParse(await c.req.json());
    if (!parsed.success || Object.keys(parsed.data).includes(conn.auth.headerName.toLowerCase())) return c.json({ error: "Invalid extra headers: use unique names, no line breaks, and no authentication or transport overrides" }, 400);
    app.connections.setHeaders(conn.id, parsed.data);
    return c.json(app.connections.get(conn.id));
  });

  r.get("/connections/:id/discovery", (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    return c.json({ override: app.connections.discovery(conn.id) ?? null, effective: app.connections.discovery(conn.id) ?? app.profiles.get(conn.profileId)?.listModels ?? null });
  });

  r.put("/connections/:id/discovery", async (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    const parsed = DiscoverySpec.nullable().safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid discovery configuration", issues: parsed.error.issues }, 400);
    const current = app.connections.discovery(conn.id) ?? app.profiles.get(conn.profileId)?.listModels;
    const previous = current?.dialect === parsed.data?.dialect ? current : undefined;
    app.connections.setDiscovery(conn.id, parsed.data ? { ...previous, ...parsed.data, defaultParams: parsed.data.defaultParams ? { ...previous?.defaultParams, ...parsed.data.defaultParams } : previous?.defaultParams } : null);
    return c.json({ ok: true });
  });

  /** Discover (list where possible) then probe catalog models. */
  r.post("/connections/:id/probe", async (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    const profile = app.profiles.get(conn.profileId);
    const includeListed = c.req.query("includeListed") === "true";
    // discover=false tests only the models Rig already has, without asking the provider for a list.
    const discover = c.req.query("discover") !== "false";
    const listing = !discover
      ? { added: [], found: undefined, error: undefined }
      : profile
        ? await discoverListed(app, conn, profile)
        : { added: [], found: undefined, error: "No gateway profile available for discovery" };
    const models = await probeConnection(app, conn, { includeListed });
    const boundDefault = ensureDefaultAlias(app);
    return c.json({ models, listed: listing.added.length, found: listing.found, listError: listing.error, boundDefault });
  });

  r.post("/connections/:id/models", async (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    const parsed = ManualModel.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const m = app.models.upsert(manualModel(conn, parsed.data));
    return c.json(m, 201);
  });

  r.get("/models", (c) => {
    const conns = new Map(app.connections.list().map((x) => [x.id, x]));
    return c.json(app.models.list().map((m) => ({ ...m, connectionName: conns.get(m.connectionId)?.name ?? "?" })));
  });

  r.patch("/models/:connectionId/:providerModelId", async (c) => {
    const model = app.models.find(c.req.param("connectionId"), c.req.param("providerModelId"));
    if (!model) return c.json({ error: "not found" }, 404);
    if (model.origin !== "manual") return c.json({ error: "Only manually added models can be edited" }, 409);
    const parsed = EditManualModel.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const b = parsed.data;
    const updated = {
      ...model,
      displayName: b.displayName === undefined ? model.displayName : b.displayName || model.providerModelId,
      dialect: b.dialect ?? model.dialect,
      route: b.route ?? model.route,
      query: b.query ?? model.query,
      bodyModel: b.bodyModel === undefined ? model.bodyModel : b.bodyModel || model.providerModelId,
      capabilities: { ...model.capabilities, reasoning: b.reasoning ?? model.capabilities.reasoning },
      params: { ...model.params, ...(b.maxTokensField ? { maxTokensField: b.maxTokensField } : {}) },
      // A previous entitlement result says nothing about the edited endpoint.
      status: "unprobed" as const,
      statusMessage: undefined,
      lastProbedAt: undefined,
    };
    app.models.upsert(updated);
    return c.json(updated);
  });

  r.post("/models/:connectionId/:providerModelId/probe", async (c) => {
    const conn = app.connections.get(c.req.param("connectionId"));
    const model = conn && app.models.find(conn.id, c.req.param("providerModelId"));
    if (!conn || !model) return c.json({ error: "not found" }, 404);
    const probed = await probeModel(app, conn, model);
    ensureDefaultAlias(app);
    return c.json(probed);
  });

  r.delete("/models/:connectionId/:providerModelId", (c) => {
    const model = app.models.find(c.req.param("connectionId"), c.req.param("providerModelId"));
    if (!model) return c.json({ error: "not found" }, 404);
    app.models.delete(model.id);
    return c.json({ ok: true });
  });

  r.get("/aliases", (c) => c.json(app.models.listAliases()));

  r.put("/aliases/:alias", async (c) => {
    const alias = c.req.param("alias");
    const b = z.object({ connectionId: z.string(), modelId: z.string() }).safeParse(await c.req.json());
    if (!b.success) return c.json({ error: "invalid body" }, 400);
    if (!app.models.find(b.data.connectionId, b.data.modelId)) return c.json({ error: "model not found" }, 404);
    app.models.setAlias({ alias, ...b.data });
    return c.json({ ok: true });
  });

  r.delete("/aliases/:alias", (c) => {
    app.models.deleteAlias(c.req.param("alias"));
    return c.json({ ok: true });
  });

  return r;
}
