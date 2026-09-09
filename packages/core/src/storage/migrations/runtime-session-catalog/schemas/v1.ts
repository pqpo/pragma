export const RUNTIME_SESSION_CATALOG_V1_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runtime_sessions(
    system_session_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    owner_type TEXT NOT NULL CHECK(owner_type IN ('expert-session', 'flow-execution')),
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runtime_sessions_owner_idx
    ON runtime_sessions(owner_id, updated_at);
  CREATE TABLE IF NOT EXISTS runtime_session_deletions(
    deletion_id TEXT PRIMARY KEY,
    owner_ids_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared', 'committed')),
    prepared_at TEXT NOT NULL
  );
`;
