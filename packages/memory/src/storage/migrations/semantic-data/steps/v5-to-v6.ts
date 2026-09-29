import type { DatabaseSync } from "node:sqlite";
import { initializeMemoryIndexOutbox } from "../../../../retrieval/outbox.ts";
export function migrateSemanticDataV5ToV6(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    initializeMemoryIndexOutbox(database, "current_facts");
    database.exec("PRAGMA user_version = 6; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
