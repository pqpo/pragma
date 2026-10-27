import type { DatabaseSync } from "node:sqlite";

/** Caller holds the catalog migration lock; SQLite WAL journals the atomic DDL. */
export function migrateRuntimeSessionCatalogV1ToV2(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS runtime_session_record_backups(
      system_session_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      from_version INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY(system_session_id, owner_id, from_version)
    )`);
    database.prepare("UPDATE metadata SET value = '2' WHERE key = 'schema_version'").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
