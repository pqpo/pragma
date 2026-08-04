import type { DatabaseSync } from "node:sqlite";

import { SemanticExtractionJobV1Schema } from "../schemas/v1.ts";
import { SemanticExtractionJobV2Schema } from "../schemas/v2.ts";

export function migrateSemanticJobsV1ToV2(database: DatabaseSync): void {
  const rows = database
    .prepare("SELECT id, job_json AS jobJson FROM jobs")
    .all() as unknown as readonly { readonly id: string; readonly jobJson: string }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS capture_stats (
        execution_id TEXT PRIMARY KEY,
        stats_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deleted_executions (
        execution_id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL
      );
    `);
    for (const row of rows) {
      const previous = SemanticExtractionJobV1Schema.parse(JSON.parse(row.jobJson));
      const migrated = SemanticExtractionJobV2Schema.parse({
        ...previous,
        schemaVersion: "pragma.memory-semantic-job/v2",
        revision: 1,
        totalAttempts: previous.attempts,
        ...(previous.status === "completed"
          ? { completedAt: previous.updatedAt }
          : previous.status === "needs_attention"
            ? {
                attentionSince: previous.updatedAt,
                failureClass: "transient-exhausted",
              }
            : {}),
      });
      database
        .prepare("UPDATE jobs SET status = ?, job_json = ? WHERE id = ?")
        .run(migrated.status, JSON.stringify(migrated), row.id);
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
