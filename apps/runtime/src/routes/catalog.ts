import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_CAPABILITIES, type Dialect } from "@rig/core";
import type { AppContext } from "../context";
import { discoverListed, ensureDefaultAlias, entryToModel, probeConnection, probeModel, seedFromProfile } from "../catalog";
import { newId } from "../ids";

const CreateConnection = z.object({
  name: z.string().min(1).max(60),
  profileId: z.string().min(1),
  key: z.string().min(1),
  baseUrl: z.string().url().optional(),
  headerName: z.string().min(1).optional(),
  headerPrefix: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  kind: z.enum(["direct", "gateway", "local"]).optional(),
});

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

const EditManualModel = ManualModel.omit({ id: true, pricing: true }).partial().strict();

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
      extraHeaders: { ...(profile.extraHeaders ?? {}), ...(b.extraHeaders ?? {}) },
      secretLast4: b.key.slice(-4),
    });
    const models = seedFromProfile(app, conn, profile);
    return c.json({ connection: conn, models }, 201);
  });

  r.delete("/connections/:id", async (c) => {
    const id = c.req.param("id");
    if (!app.connections.get(id)) return c.json({ error: "not found" }, 404);
    await app.secrets.delete(id);
    app.connections.delete(id);
    return c.json({ ok: true });
  });

  /** Discover (list where possible) then probe catalog models. */
  r.post("/connections/:id/probe", async (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    const profile = app.profiles.get(conn.profileId);
    const includeListed = c.req.query("includeListed") === "true";
    const listing = profile ? await discoverListed(app, conn, profile) : { added: [] };
    const models = await probeConnection(app, conn, { includeListed });
    const boundDefault = ensureDefaultAlias(app);
    return c.json({ models, listed: listing.added.length, listError: listing.error, boundDefault });
  });

  r.post("/connections/:id/models", async (c) => {
    const conn = app.connections.get(c.req.param("id"));
    if (!conn) return c.json({ error: "not found" }, 404);
    const parsed = ManualModel.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    const b = parsed.data;
    const m = entryToModel(
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
    app.models.upsert(m);
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
