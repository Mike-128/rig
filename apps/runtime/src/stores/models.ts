import { DEFAULT_CAPABILITIES, type Capabilities, type Dialect, type EntitlementStatus, type Model, type ModelAlias, type ModelParams, type Pricing } from "@harness/core";
import { json, type Db } from "../db";

interface Row {
  id: string;
  connection_id: string;
  provider_model_id: string;
  body_model: string;
  display_name: string;
  dialect: string;
  route: string;
  query: string | null;
  capabilities: string;
  pricing: string | null;
  params: string | null;
  status: string;
  status_message: string | null;
  last_probed_at: string | null;
  origin: string;
}

function toModel(r: Row): Model {
  return {
    id: r.id,
    connectionId: r.connection_id,
    providerModelId: r.provider_model_id,
    bodyModel: r.body_model,
    displayName: r.display_name,
    dialect: r.dialect as Dialect,
    route: r.route,
    query: json<Record<string, string> | undefined>(r.query, undefined),
    capabilities: json<Capabilities>(r.capabilities, DEFAULT_CAPABILITIES),
    pricing: json<Pricing | undefined>(r.pricing, undefined),
    params: json<ModelParams | undefined>(r.params, undefined),
    status: r.status as EntitlementStatus,
    statusMessage: r.status_message ?? undefined,
    lastProbedAt: r.last_probed_at ?? undefined,
    origin: r.origin as Model["origin"],
  };
}

export function modelId(connectionId: string, providerModelId: string): string {
  return `${connectionId}/${providerModelId}`;
}

export class ModelStore {
  constructor(private db: Db) {}

  list(connectionId?: string): Model[] {
    const rows = connectionId
      ? (this.db.prepare("SELECT * FROM models WHERE connection_id = ? ORDER BY display_name").all(connectionId) as unknown as Row[])
      : (this.db.prepare("SELECT * FROM models ORDER BY connection_id, display_name").all() as unknown as Row[]);
    return rows.map(toModel);
  }

  get(id: string): Model | undefined {
    const r = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as unknown as Row | undefined;
    return r ? toModel(r) : undefined;
  }

  find(connectionId: string, providerModelId: string): Model | undefined {
    return this.get(modelId(connectionId, providerModelId));
  }

  /** Match a request body's model field against a connection's models (id or bodyModel). */
  findByBodyModel(connectionId: string, bodyModel: string): Model | undefined {
    const r = this.db
      .prepare("SELECT * FROM models WHERE connection_id = ? AND (provider_model_id = ? OR body_model = ?) LIMIT 1")
      .get(connectionId, bodyModel, bodyModel) as unknown as Row | undefined;
    return r ? toModel(r) : undefined;
  }

  upsert(m: Model): Model {
    this.db
      .prepare(
        `INSERT INTO models (id, connection_id, provider_model_id, body_model, display_name, dialect, route, query, capabilities, pricing, params, status, status_message, last_probed_at, origin)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET body_model=excluded.body_model, display_name=excluded.display_name, dialect=excluded.dialect, route=excluded.route,
           query=excluded.query, capabilities=excluded.capabilities, pricing=excluded.pricing, params=excluded.params, status=excluded.status,
           status_message=excluded.status_message, last_probed_at=excluded.last_probed_at, origin=excluded.origin`,
      )
      .run(
        m.id,
        m.connectionId,
        m.providerModelId,
        m.bodyModel,
        m.displayName,
        m.dialect,
        m.route,
        m.query ? JSON.stringify(m.query) : null,
        JSON.stringify(m.capabilities),
        m.pricing ? JSON.stringify(m.pricing) : null,
        m.params ? JSON.stringify(m.params) : null,
        m.status,
        m.statusMessage ?? null,
        m.lastProbedAt ?? null,
        m.origin,
      );
    return m;
  }

  setStatus(id: string, status: EntitlementStatus, message: string | undefined, at: string): void {
    this.db.prepare("UPDATE models SET status = ?, status_message = ?, last_probed_at = ? WHERE id = ?").run(status, message ?? null, at, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
  }

  // aliases
  listAliases(): ModelAlias[] {
    return this.db.prepare("SELECT alias, connection_id as connectionId, model_id as modelId FROM aliases ORDER BY alias").all() as unknown as ModelAlias[];
  }

  getAlias(alias: string): ModelAlias | undefined {
    return this.db.prepare("SELECT alias, connection_id as connectionId, model_id as modelId FROM aliases WHERE alias = ?").get(alias) as unknown as ModelAlias | undefined;
  }

  setAlias(a: ModelAlias): void {
    this.db
      .prepare("INSERT INTO aliases (alias, connection_id, model_id) VALUES (?,?,?) ON CONFLICT(alias) DO UPDATE SET connection_id=excluded.connection_id, model_id=excluded.model_id")
      .run(a.alias, a.connectionId, a.modelId);
  }

  deleteAlias(alias: string): void {
    this.db.prepare("DELETE FROM aliases WHERE alias = ?").run(alias);
  }
}
