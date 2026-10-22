import type { DatabaseSync } from "node:sqlite";
export function migrateSemanticDataV6ToV7(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`ALTER TABLE projection_notifications ADD COLUMN source_changed INTEGER NOT NULL DEFAULT 0;
      UPDATE projection_notifications SET source_changed=1 WHERE id LIKE 'fact:%';
      PRAGMA user_version=7; COMMIT;`);
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
