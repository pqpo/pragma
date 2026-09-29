import type { DatabaseSync } from "node:sqlite";
export interface MemoryIndexChange {
  readonly sequence: number;
  readonly memoryId: string;
  readonly revision: number;
  readonly deleted: boolean;
}
export function initializeMemoryIndexOutbox(
  db: DatabaseSync,
  table: "episodes" | "current_facts",
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS retrieval_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), sequence INTEGER NOT NULL);
 INSERT OR IGNORE INTO retrieval_clock VALUES (1,0);
 CREATE TABLE IF NOT EXISTS retrieval_outbox (memory_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS retrieval_outbox_sequence ON retrieval_outbox(sequence);`);
  for (const [event, ref, deleted] of [
    ["INSERT", "NEW", 0],
    ["UPDATE", "NEW", 0],
    ["DELETE", "OLD", 1],
  ] as const) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS retrieval_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
   UPDATE retrieval_clock SET sequence=sequence+1 WHERE singleton=1;
   INSERT INTO retrieval_outbox(memory_id,sequence,revision,deleted) VALUES (${ref}.id,(SELECT sequence FROM retrieval_clock WHERE singleton=1),${ref}.revision,${deleted})
   ON CONFLICT(memory_id) DO UPDATE SET sequence=excluded.sequence,revision=excluded.revision,deleted=excluded.deleted;
  END;`);
  }
}
export function memoryIndexOutbox(db: DatabaseSync, table: "episodes" | "current_facts") {
  return {
    async readIndexRemovals(limit: number): Promise<readonly MemoryIndexChange[]> {
      const rows = db
        .prepare(
          `
        SELECT o.sequence,o.memory_id AS memoryId,o.revision,o.deleted
        FROM retrieval_outbox o LEFT JOIN ${table} r ON r.id=o.memory_id
        WHERE r.id IS NULL OR r.status <> 'active'
          OR json_extract(r.record_json,'$.sensitivity')='restricted'
          OR json_extract(r.record_json,'$.expiresAt')<=?
        ORDER BY o.sequence LIMIT ?
      `,
        )
        .all(new Date().toISOString(), Math.max(1, Math.min(limit, 200))) as unknown as Array<
        Omit<MemoryIndexChange, "deleted"> & { deleted: number }
      >;
      return rows.map((value) => ({ ...value, deleted: value.deleted === 1 }));
    },
    async readIndexChanges(limit: number): Promise<readonly MemoryIndexChange[]> {
      return (
        db
          .prepare(
            "SELECT sequence,memory_id AS memoryId,revision,deleted FROM retrieval_outbox ORDER BY sequence LIMIT ?",
          )
          .all(Math.max(1, Math.min(limit, 200))) as unknown as Array<
          Omit<MemoryIndexChange, "deleted"> & { deleted: number }
        >
      ).map((value) => ({ ...value, deleted: value.deleted === 1 }));
    },
    async acknowledgeIndexChange(change: MemoryIndexChange): Promise<void> {
      db.prepare("DELETE FROM retrieval_outbox WHERE memory_id=? AND sequence=?").run(
        change.memoryId,
        change.sequence,
      );
    },
    async indexWatermark(): Promise<number> {
      return (
        db.prepare("SELECT sequence FROM retrieval_clock WHERE singleton=1").get() as {
          sequence: number;
        }
      ).sequence;
    },
  };
}
