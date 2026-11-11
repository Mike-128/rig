import type { AuthSpec, Connection, ConnectionKind, ListModelsSpec } from "@rig/core";
import { json, nowIso, type Db } from "../db";

interface Row {
  id: string;
  name: string;
  profile_id: string;
  kind: string;
  base_url: string;
  auth_header: string;
  auth_prefix: string | null;
  extra_headers: string | null;
  secret_last4: string;
  created_at: string;
}

function toConnection(r: Row): Connection {
  return {
    id: r.id,
    name: r.name,
    profileId: r.profile_id,
    kind: r.kind as ConnectionKind,
    baseUrl: r.base_url,
    auth: { headerName: r.auth_header, prefix: r.auth_prefix ?? undefined },
    extraHeaders: json<Record<string, string> | undefined>(r.extra_headers, undefined),
    secretLast4: r.secret_last4,
    createdAt: r.created_at,
  };
}

export class ConnectionStore {
  constructor(private db: Db) {}

  list(): Connection[] {
    return (this.db.prepare("SELECT * FROM connections ORDER BY created_at").all() as unknown as Row[]).map(toConnection);
  }

  get(id: string): Connection | undefined {
    const r = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as unknown as Row | undefined;
    return r ? toConnection(r) : undefined;
  }

  getByName(name: string): Connection | undefined {
    const r = this.db.prepare("SELECT * FROM connections WHERE name = ?").get(name) as unknown as Row | undefined;
    return r ? toConnection(r) : undefined;
  }

  create(c: { id: string; name: string; profileId: string; kind: ConnectionKind; baseUrl: string; auth: AuthSpec; extraHeaders?: Record<string, string>; secretLast4: string }): Connection {
    const createdAt = nowIso();
    this.db
      .prepare(
        "INSERT INTO connections (id, name, profile_id, kind, base_url, auth_header, auth_prefix, extra_headers, secret_last4, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(c.id, c.name, c.profileId, c.kind, c.baseUrl, c.auth.headerName, c.auth.prefix ?? null, c.extraHeaders ? JSON.stringify(c.extraHeaders) : null, c.secretLast4, createdAt);
    return this.get(c.id)!;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM aliases WHERE connection_id = ?").run(id);
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
  }

  setHeaders(id: string, headers: Record<string, string>): void {
    this.db.prepare("UPDATE connections SET extra_headers = ? WHERE id = ?").run(JSON.stringify(headers), id);
    this.db.prepare("UPDATE models SET status = 'unprobed', status_message = NULL, last_probed_at = NULL WHERE connection_id = ?").run(id);
  }

  discovery(id: string): ListModelsSpec | undefined {
    const row = this.db.prepare("SELECT spec FROM connection_discovery WHERE connection_id = ?").get(id) as { spec: string } | undefined;
    return row ? JSON.parse(row.spec) : undefined;
  }

  setDiscovery(id: string, spec: ListModelsSpec | null): void {
    if (!spec) this.db.prepare("DELETE FROM connection_discovery WHERE connection_id = ?").run(id);
    else this.db.prepare("INSERT INTO connection_discovery (connection_id, spec) VALUES (?, ?) ON CONFLICT(connection_id) DO UPDATE SET spec = excluded.spec").run(id, JSON.stringify(spec));
  }
}
