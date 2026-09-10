import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_header TEXT NOT NULL,
  auth_prefix TEXT,
  extra_headers TEXT,
  secret_last4 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider_model_id TEXT NOT NULL,
  body_model TEXT NOT NULL,
  display_name TEXT NOT NULL,
  dialect TEXT NOT NULL,
  route TEXT NOT NULL,
  query TEXT,
  capabilities TEXT NOT NULL,
  pricing TEXT,
  params TEXT,
  status TEXT NOT NULL,
  status_message TEXT,
  last_probed_at TEXT,
  origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connection_discovery (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  spec TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS models_conn ON models(connection_id);
CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  model_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  agent_slug TEXT NOT NULL,
  agent_version INTEGER NOT NULL,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  usage TEXT,
  cost_usd REAL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
