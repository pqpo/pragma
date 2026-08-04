import type { DatabaseSync } from "node:sqlite";

export function migrateCanonicalEventFeedV1ToV2(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      ALTER TABLE canonical_events ADD COLUMN correlation_id TEXT;
      ALTER TABLE canonical_events ADD COLUMN envelope_bytes INTEGER;
      CREATE INDEX canonical_events_correlation ON canonical_events(correlation_id, sequence);
      CREATE TABLE event_receipts (
        event_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        correlation_id TEXT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_cursor TEXT
      );
      CREATE INDEX event_receipts_correlation ON event_receipts(correlation_id);
      CREATE TABLE feed_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO feed_metadata(key, value)
        VALUES ('last_sequence', CAST((SELECT COALESCE(MAX(sequence), 0) FROM canonical_events) AS TEXT));
      PRAGMA user_version = 2;
    `);
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // No migration transaction remained active.
    }
    throw error;
  }
}
