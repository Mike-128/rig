import {
  adapterFor,
  DEFAULT_CAPABILITIES,
  proxyBaseUrl,
  type AdapterConnection,
  type Connection,
  type GatewayProfile,
  type Model,
  type ModelAlias,
  type ProfileModelEntry,
} from "@rig/core";
import type { AppContext } from "./context";
import { modelId } from "./stores/models";
import { nowIso } from "./db";

export function entryToModel(conn: Connection, e: ProfileModelEntry, origin: Model["origin"] = "catalog"): Model {
  return {
    id: modelId(conn.id, e.id),
    connectionId: conn.id,
    providerModelId: e.id,
    bodyModel: e.bodyModel ?? e.id,
    displayName: e.displayName ?? e.id,
    dialect: e.dialect,
    route: e.route,
    query: e.query,
    capabilities: { ...DEFAULT_CAPABILITIES, ...(e.capabilities ?? {}) },
    pricing: e.pricing,
    params: e.params,
    status: "unprobed",
    origin,
  };
}

export function adapterConnection(app: AppContext, conn: Connection, model: Model): AdapterConnection {
  return {
    baseUrl: proxyBaseUrl(app.config.proxyOrigin, conn.id, model.dialect),
    headers: { "x-rig-proxy-token": app.config.proxyToken },
    modelId: model.providerModelId,
  };
}

/** Seed a connection's models from its profile catalog. */
export function seedFromProfile(app: AppContext, conn: Connection, profile: GatewayProfile): Model[] {
  return profile.models.map((e) => app.models.upsert(entryToModel(conn, e)));
}

/** List models through the gateway (when the profile supports it) and add unknown ones as "listed". */
export async function discoverListed(app: AppContext, conn: Connection, profile: GatewayProfile): Promise<{ added: Model[]; error?: string }> {
  const spec = profile.listModels;
  if (!spec) return { added: [] };
  const adapter = adapterFor(spec.dialect);
  const pseudo = { ...entryToModel(conn, { id: "__list__", dialect: spec.dialect, route: spec.route }) };
  try {
    const ids = await adapter.listModels(adapterConnection(app, conn, pseudo));
    const filter = spec.filter ? new RegExp(spec.filter) : undefined;
    const added: Model[] = [];
    for (let raw of ids) {
      if (spec.stripPrefix && raw.startsWith(spec.stripPrefix)) raw = raw.slice(spec.stripPrefix.length);
      if (filter && !filter.test(raw)) continue;
      if (app.models.find(conn.id, raw)) continue;
      const m = entryToModel(conn, { id: raw, dialect: spec.dialect, route: spec.defaultRoute, query: spec.defaultQuery, params: spec.defaultParams }, "listed");
      m.status = "listed";
      added.push(app.models.upsert(m));
    }
    return { added };
  } catch (e) {
    return { added: [], error: adapter.normalizeError(e).message };
  }
}

/** Probe one model: a minimal request, classified into an entitlement status. */
export async function probeModel(app: AppContext, conn: Connection, model: Model): Promise<Model> {
  const adapter = adapterFor(model.dialect);
  const r = await adapter.probe(adapterConnection(app, conn, model), model);
  const at = nowIso();
  const msg = r.message ? `${r.message} (${r.latencyMs} ms)` : `${r.latencyMs} ms`;
  app.models.setStatus(model.id, r.status, msg, at);
  return app.models.get(model.id)!;
}

/** Probe every catalog model on a connection, a few at a time. Listed-only models are left for the user. */
export async function probeConnection(app: AppContext, conn: Connection, opts: { includeListed?: boolean; concurrency?: number } = {}): Promise<Model[]> {
  const models = app.models.list(conn.id).filter((m) => opts.includeListed || m.origin !== "listed");
  const results: Model[] = [];
  const limit = opts.concurrency ?? 4;
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, models.length) }, async () => {
      while (i < models.length) {
        const m = models[i++];
        results.push(await probeModel(app, conn, m));
      }
    }),
  );
  return app.models.list(conn.id);
}

/** Entitled, but not a general-purpose chat model. */
const NON_CHAT = /embed|transcribe|translate|tts|audio|speech|image|imagen|veo|whisper|rerank|moderation/i;

/** Preview and experimental models usually carry much tighter quota, so they make a poor default. */
const PREVIEW = /preview|experimental|-exp|-exp-/i;

/**
 * Bind the "default" alias if it is unset, so the seeded agents work as soon as a key is added.
 * Prefers a curated, generally available chat model; never overwrites a binding the user already made.
 */
export function ensureDefaultAlias(app: AppContext): ModelAlias | undefined {
  if (app.models.getAlias("default")) return undefined;
  const candidates = app.models
    .list()
    .filter((m) => m.status === "entitled" && !NON_CHAT.test(m.providerModelId))
    .sort((a, b) => rank(a) - rank(b));
  const pick = candidates[0] ?? app.models.list().find((m) => m.status === "entitled");
  if (!pick) return undefined;
  const alias: ModelAlias = { alias: "default", connectionId: pick.connectionId, modelId: pick.providerModelId };
  app.models.setAlias(alias);
  return alias;
}

/** Lower sorts first: curated catalog entries beat discovered ones, and stable beats preview. */
function rank(m: Model): number {
  return (m.origin === "catalog" ? 0 : 2) + (PREVIEW.test(m.providerModelId) ? 1 : 0);
}
