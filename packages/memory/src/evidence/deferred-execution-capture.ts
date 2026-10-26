import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { z } from "zod";

const EntrySchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
});
export type DeferredExecutionCapture = z.infer<typeof EntrySchema>;

/** References only; the canonical Feed remains the authority for deferred content. */
export interface DeferredExecutionCaptureStore {
  put(entry: DeferredExecutionCapture): Promise<void>;
  next(limit: number): Promise<readonly DeferredExecutionCapture[]>;
  remove(eventId: string): Promise<void>;
  inspect(): Promise<{ pending: number; safeThrough: number }>;
}

export function createDeferredExecutionCaptureStore(options: {
  pragmaHome: string;
}): DeferredExecutionCaptureStore {
  const root = new PragmaPaths(options).memoryModuleStateRoot(
    "pragma.memory.execution-evidence-adapter",
  );
  const open = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(root, "capture-deferred-v1.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      db.exec("BEGIN IMMEDIATE");
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      if (version !== 0 && version !== 1)
        throw new Error("memory_execution_capture_version_unsupported");
      if (version === 0) {
        if (
          db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get() !== undefined
        )
          throw new Error("memory_execution_capture_state_invalid");
        db.exec(`CREATE TABLE pending(event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE);
          CREATE TABLE replay(singleton INTEGER PRIMARY KEY, sequence INTEGER NOT NULL);
          INSERT INTO replay VALUES(1, 0);
          PRAGMA user_version=1;`);
      }
      db.exec("COMMIT");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  return {
    async put(input) {
      const entry = EntrySchema.parse(input);
      const db = await open();
      try {
        db.exec("BEGIN IMMEDIATE");
        const existing = db
          .prepare("SELECT sequence FROM pending WHERE event_id=?")
          .get(entry.eventId) as { sequence: number } | undefined;
        if (existing !== undefined && existing.sequence !== entry.sequence)
          throw new Error("memory_execution_capture_source_changed");
        if (existing === undefined) {
          const { count } = db.prepare("SELECT COUNT(*) AS count FROM pending").get() as {
            count: number;
          };
          if (count >= 10_000) throw new Error("memory_execution_capture_capacity");
          db.prepare("INSERT INTO pending VALUES(?, ?)").run(entry.eventId, entry.sequence);
        }
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    },
    async next(limit) {
      const db = await open();
      try {
        db.exec("BEGIN IMMEDIATE");
        const { sequence } = db.prepare("SELECT sequence FROM replay WHERE singleton=1").get() as {
          sequence: number;
        };
        const query = db.prepare(
          "SELECT event_id AS eventId, sequence FROM pending WHERE sequence > ? ORDER BY sequence LIMIT ?",
        );
        let rows = query.all(sequence, limit);
        if (rows.length === 0) rows = query.all(0, limit);
        const entries = z.array(EntrySchema).parse(rows);
        db.prepare("UPDATE replay SET sequence=? WHERE singleton=1").run(
          entries.at(-1)?.sequence ?? 0,
        );
        db.exec("COMMIT");
        return entries;
      } finally {
        db.close();
      }
    },
    async remove(eventId) {
      const db = await open();
      try {
        db.prepare("DELETE FROM pending WHERE event_id=?").run(eventId);
      } finally {
        db.close();
      }
    },
    async inspect() {
      const db = await open();
      try {
        const row = db
          .prepare("SELECT COUNT(*) AS pending, MIN(sequence) AS first FROM pending")
          .get() as { pending: number; first: number | null };
        return {
          pending: row.pending,
          safeThrough: row.first === null ? Number.POSITIVE_INFINITY : row.first - 1,
        };
      } finally {
        db.close();
      }
    },
  };
}
