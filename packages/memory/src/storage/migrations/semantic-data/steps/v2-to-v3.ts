import type { DatabaseSync } from "node:sqlite";

export function migrateSemanticDataV2ToV3(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      ALTER TABLE applied_jobs RENAME TO applied_jobs_v2;
      CREATE TABLE applied_jobs (
        job_id TEXT NOT NULL,
        input_watermark TEXT NOT NULL,
        terminal_message_id TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (job_id, input_watermark)
      );
      INSERT INTO applied_jobs(job_id, input_watermark, terminal_message_id, applied_at)
        SELECT job_id, terminal_message_id, terminal_message_id, applied_at FROM applied_jobs_v2;
      DROP TABLE applied_jobs_v2;
      PRAGMA user_version = 3;
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // No migration transaction remained active.
    }
    throw error;
  }
}
