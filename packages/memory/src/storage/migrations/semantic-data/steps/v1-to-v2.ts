import type { DatabaseSync } from "node:sqlite";

export function migrateSemanticDataV1ToV2(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    // v2 adds governance-side tables but does not change pragma.memory-semantic/v1 records.
    database.exec("PRAGMA user_version = 2; COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // No migration transaction remained active.
    }
    throw error;
  }
}
