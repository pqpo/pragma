import type { DatabaseSync } from "node:sqlite";

export function migrateEpisodicDataV3ToV4(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE TABLE memory_index (
        memory_id TEXT NOT NULL,
        consumer_key TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('hot', 'archived')),
        score REAL NOT NULL,
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at TEXT,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, consumer_key),
        FOREIGN KEY (memory_id) REFERENCES episodes(id) ON DELETE CASCADE
      );
      CREATE INDEX memory_index_consumer_tier_score
        ON memory_index(consumer_key, tier, score DESC, memory_id);
      CREATE TABLE revision_prune_audit (
        memory_id TEXT PRIMARY KEY,
        pruned_through_revision INTEGER NOT NULL,
        pruned_count INTEGER NOT NULL,
        pruned_at TEXT NOT NULL
      );
      PRAGMA user_version = 4;
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
