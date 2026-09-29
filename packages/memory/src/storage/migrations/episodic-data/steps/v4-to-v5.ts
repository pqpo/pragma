import type { DatabaseSync } from "node:sqlite";
import { initializeMemoryIndexOutbox } from "../../../../retrieval/outbox.ts";
export function migrateEpisodicDataV4ToV5(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    initializeMemoryIndexOutbox(database, "episodes");
    database.exec("PRAGMA user_version = 5; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
