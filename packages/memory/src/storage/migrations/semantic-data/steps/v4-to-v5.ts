import type { DatabaseSync } from "node:sqlite";

export function migrateSemanticDataV4ToV5(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      ALTER TABLE projection_notifications
        ADD COLUMN learning_eligible INTEGER NOT NULL DEFAULT 0
        CHECK (learning_eligible IN (0, 1));
      PRAGMA user_version = 5;
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      /* transaction already closed */
    }
    throw error;
  }
}
