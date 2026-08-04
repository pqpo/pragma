import type { DatabaseSync } from "node:sqlite";

import { EpisodicMemoryRecordV1Schema } from "../schemas/v1.ts";
import { EpisodicMemoryRecordV2Schema } from "../schemas/v2.ts";

export function migrateEpisodicDataV1ToV2(database: DatabaseSync): void {
  const rows = database
    .prepare("SELECT id, record_json AS recordJson FROM episodes")
    .all() as unknown as readonly { readonly id: string; readonly recordJson: string }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS episode_evidence (
        episode_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        PRIMARY KEY (episode_id, evidence_id),
        FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS episode_revisions (
        episode_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (episode_id, revision)
      );
      CREATE TABLE IF NOT EXISTS governance_events (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tombstones (
        id TEXT PRIMARY KEY,
        last_revision INTEGER NOT NULL,
        forgotten_at TEXT NOT NULL,
        tombstone_json TEXT NOT NULL
      );
    `);
    for (const row of rows) {
      const previous = EpisodicMemoryRecordV1Schema.parse(JSON.parse(row.recordJson));
      const migrated = EpisodicMemoryRecordV2Schema.parse({
        ...previous,
        schemaVersion: "pragma.memory-episodic/v2",
        bindings: previous.bindings.map((consumerRef) => ({
          consumerRef,
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        })),
      });
      database
        .prepare("UPDATE episodes SET record_json = ? WHERE id = ?")
        .run(JSON.stringify(migrated), row.id);
      database
        .prepare(
          "INSERT OR IGNORE INTO episode_revisions(episode_id, revision, record_json) VALUES (?, ?, ?)",
        )
        .run(migrated.id, migrated.revision, JSON.stringify(migrated));
    }
    database.exec("PRAGMA user_version = 2; COMMIT;");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK;");
  } catch {
    // No migration transaction remained active.
  }
}
