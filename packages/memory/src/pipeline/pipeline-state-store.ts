import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths, withFileLock } from "@pragma/core";
import { MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
import { z } from "zod";

import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";

const ConsumerStateSchema = z.object({
  schemaVersion: z.literal("pragma.memory-consumer-state/v1"),
  consumerId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  attempts: z.record(z.string(), z.number().int().nonnegative()),
  retryAfter: z.string().datetime().optional(),
  processed: z.number().int().nonnegative(),
  retried: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

const DeadLetterSchema = z.object({
  schemaVersion: z.literal("pragma.memory-dead-letter/v1"),
  consumerId: z.string().min(1),
  messageId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  errorCode: z.string().min(1),
  failedAt: z.string().datetime(),
});

const DerivedEventOutboxEntrySchema = z.object({
  schemaVersion: z.literal("pragma.memory-derived-event-outbox/v1"),
  consumerId: z.string().min(1),
  deliveryId: z.string().min(1),
  targetSequence: z.number().int().nonnegative(),
  events: z.array(MemoryEvidenceEnvelopeSchema),
  processed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type MemoryConsumerState = z.infer<typeof ConsumerStateSchema>;
export type MemoryDeadLetter = z.infer<typeof DeadLetterSchema>;
export type MemoryDerivedEventOutboxEntry = z.infer<typeof DerivedEventOutboxEntrySchema>;

export interface MemoryConsumerCheckpointStore {
  read(consumerId: string): Promise<MemoryConsumerState>;
  update(
    consumerId: string,
    updater: (current: MemoryConsumerState) => MemoryConsumerState,
  ): Promise<MemoryConsumerState>;
}

export interface MemoryDeadLetterStore {
  put(entry: MemoryDeadLetter): Promise<void>;
  list(consumerId: string): Promise<readonly MemoryDeadLetter[]>;
}

export interface MemoryPipelineMaintenanceStore {
  maintain(now: Date): Promise<{ readonly deletedDeadLetters: number }>;
  inspectDeadLetters(): Promise<{ readonly entries: number; readonly bytes: number }>;
}

export interface MemoryDerivedEventOutboxStore {
  enqueue(entry: MemoryDerivedEventOutboxEntry): Promise<void>;
  listPending(consumerId: string): Promise<readonly MemoryDerivedEventOutboxEntry[]>;
  acknowledge(consumerId: string, deliveryId: string): Promise<void>;
}

export function createFileMemoryPipelineStateStore(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): MemoryConsumerCheckpointStore &
  MemoryDeadLetterStore &
  MemoryDerivedEventOutboxStore &
  MemoryPipelineMaintenanceStore {
  const paths = new PragmaPaths(options);
  const now = options.now ?? (() => new Date());
  const statePath = (consumerId: string) =>
    join(paths.memoryModuleStateRoot(consumerId), "consumer.json");
  const legacyDeadLetterPath = (consumerId: string) =>
    join(paths.memoryModuleStateRoot(consumerId), "dead-letters.json");
  const deadLetterPath = (consumerId: string) =>
    join(paths.memoryModuleStateRoot(consumerId), "dead-letters.sqlite");
  const lockPath = (consumerId: string) => join(paths.memoryModuleStateRoot(consumerId), ".lock");
  const outboxPath = (consumerId: string) =>
    join(paths.memoryModuleStateRoot(consumerId), "derived-event-outbox.json");
  const knownConsumers = new Set<string>();

  const remember = (consumerId: string): void => {
    knownConsumers.add(consumerId);
  };

  return {
    async read(consumerId) {
      remember(consumerId);
      return await readState(statePath(consumerId), consumerId, now);
    },

    async update(consumerId, updater) {
      remember(consumerId);
      return await withFileLock(lockPath(consumerId), async () => {
        const current = await readState(statePath(consumerId), consumerId, now);
        const next = ConsumerStateSchema.parse(updater(current));
        if (next.consumerId !== consumerId || next.sequence < current.sequence) {
          throw new Error(`Invalid Memory checkpoint transition for ${consumerId}.`);
        }
        await writeJsonAtomic(statePath(consumerId), next);
        return next;
      });
    },

    async put(input) {
      const entry = DeadLetterSchema.parse(input);
      remember(entry.consumerId);
      await withFileLock(lockPath(entry.consumerId), async () => {
        const database = await openDeadLetterDatabase(
          deadLetterPath(entry.consumerId),
          legacyDeadLetterPath(entry.consumerId),
        );
        try {
          database
            .prepare(
              `INSERT OR IGNORE INTO dead_letters(message_id, failed_at, record_json)
               VALUES (?, ?, ?)`,
            )
            .run(entry.messageId, entry.failedAt, JSON.stringify(entry));
          pruneDeadLetters(database, now());
        } finally {
          database.close();
        }
      });
    },

    async list(consumerId) {
      remember(consumerId);
      const database = await openDeadLetterDatabase(
        deadLetterPath(consumerId),
        legacyDeadLetterPath(consumerId),
      );
      try {
        return readDeadLetters(database);
      } finally {
        database.close();
      }
    },

    async enqueue(input) {
      const entry = DerivedEventOutboxEntrySchema.parse(input);
      remember(entry.consumerId);
      await withFileLock(lockPath(entry.consumerId), async () => {
        const existing = await readOutbox(outboxPath(entry.consumerId));
        const duplicate = existing.find((candidate) => candidate.deliveryId === entry.deliveryId);
        if (duplicate !== undefined) {
          if (JSON.stringify(duplicate) !== JSON.stringify(entry)) {
            throw new Error(`Conflicting Memory outbox delivery: ${entry.deliveryId}`);
          }
          return;
        }
        await writeJsonAtomic(outboxPath(entry.consumerId), [...existing, entry]);
      });
    },

    async listPending(consumerId) {
      remember(consumerId);
      return await readOutbox(outboxPath(consumerId));
    },

    async acknowledge(consumerId, deliveryId) {
      remember(consumerId);
      await withFileLock(lockPath(consumerId), async () => {
        const existing = await readOutbox(outboxPath(consumerId));
        const next = existing.filter((entry) => entry.deliveryId !== deliveryId);
        if (next.length === existing.length) return;
        await writeJsonAtomic(outboxPath(consumerId), next);
      });
    },

    async maintain(maintenanceNow) {
      let deletedDeadLetters = 0;
      for (const consumerId of knownConsumers) {
        await withFileLock(lockPath(consumerId), async () => {
          const database = await openDeadLetterDatabase(
            deadLetterPath(consumerId),
            legacyDeadLetterPath(consumerId),
          );
          try {
            deletedDeadLetters += pruneDeadLetters(database, maintenanceNow);
          } finally {
            database.close();
          }
          const backup = `${legacyDeadLetterPath(consumerId)}.v1.backup`;
          await stat(backup)
            .then(async (details) => {
              if (
                maintenanceNow.getTime() - details.mtimeMs >=
                DEFAULT_MEMORY_STORAGE_POLICY.deadLetterRetentionMs
              ) {
                await rm(backup, { force: true });
              }
            })
            .catch((error: unknown) => {
              if (!isNotFound(error)) throw error;
            });
          await removeStaleAtomicTemps(paths.memoryModuleStateRoot(consumerId), maintenanceNow);
        });
      }
      return { deletedDeadLetters };
    },

    async inspectDeadLetters() {
      let entries = 0;
      let bytes = 0;
      for (const consumerId of knownConsumers) {
        const database = await openDeadLetterDatabase(
          deadLetterPath(consumerId),
          legacyDeadLetterPath(consumerId),
        );
        try {
          const row = database
            .prepare(
              "SELECT COUNT(*) AS entries, COALESCE(SUM(length(CAST(record_json AS BLOB))), 0) AS bytes FROM dead_letters",
            )
            .get() as unknown as { readonly entries: number; readonly bytes: number };
          entries += row.entries;
          bytes += row.bytes;
        } finally {
          database.close();
        }
      }
      return { entries, bytes };
    },
  };
}

async function readState(
  path: string,
  consumerId: string,
  now: () => Date,
): Promise<MemoryConsumerState> {
  const value = await readJson(path);
  if (value === undefined) {
    return ConsumerStateSchema.parse({
      schemaVersion: "pragma.memory-consumer-state/v1",
      consumerId,
      sequence: 0,
      attempts: {},
      processed: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
      updatedAt: now().toISOString(),
    });
  }
  return ConsumerStateSchema.parse(value);
}

function readDeadLetters(database: DatabaseSync): MemoryDeadLetter[] {
  const rows = database
    .prepare("SELECT record_json AS recordJson FROM dead_letters ORDER BY failed_at, message_id")
    .all() as unknown as readonly { readonly recordJson: string }[];
  return rows.map((row) => DeadLetterSchema.parse(JSON.parse(row.recordJson)));
}

async function readOutbox(path: string): Promise<MemoryDerivedEventOutboxEntry[]> {
  const value = await readJson(path);
  return value === undefined ? [] : DerivedEventOutboxEntrySchema.array().parse(value);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeStaleAtomicTemps(root: string, now: Date): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const cutoff = now.getTime() - DEFAULT_MEMORY_STORAGE_POLICY.atomicTempRetentionMs;
  for (const name of names.filter((value) => value.endsWith(".tmp"))) {
    const path = join(root, name);
    try {
      if ((await stat(path)).mtimeMs <= cutoff) await rm(path, { force: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

async function openDeadLetterDatabase(path: string, legacyPath: string): Promise<DatabaseSync> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  const version = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  if (version.user_version > 1) {
    database.close();
    throw new Error(
      `unsupported-state-version:pragma.memory-dead-letter-store/v${version.user_version}`,
    );
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS dead_letters (
      message_id TEXT PRIMARY KEY,
      failed_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dead_letters_failed_at ON dead_letters(failed_at, message_id);
    PRAGMA user_version = 1;
  `);
  const legacy = await readJson(legacyPath);
  if (legacy !== undefined) {
    try {
      const entries = DeadLetterSchema.array().parse(legacy);
      const insert = database.prepare(
        "INSERT OR IGNORE INTO dead_letters(message_id, failed_at, record_json) VALUES (?, ?, ?)",
      );
      database.exec("BEGIN IMMEDIATE;");
      for (const entry of entries) {
        insert.run(entry.messageId, entry.failedAt, JSON.stringify(entry));
      }
      database.exec("COMMIT;");
      await rename(legacyPath, `${legacyPath}.v1.backup`).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    } catch (error) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Parsing can fail before a transaction starts, or rename can fail after commit.
      }
      database.close();
      throw error;
    }
  }
  return database;
}

function pruneDeadLetters(database: DatabaseSync, now: Date): number {
  let deleted = 0;
  database.exec("BEGIN IMMEDIATE;");
  try {
    const cutoff = new Date(
      now.getTime() - DEFAULT_MEMORY_STORAGE_POLICY.deadLetterRetentionMs,
    ).toISOString();
    deleted += Number(
      database.prepare("DELETE FROM dead_letters WHERE failed_at < ?").run(cutoff).changes,
    );
    const rows = database
      .prepare(
        `SELECT message_id AS messageId, length(CAST(record_json AS BLOB)) AS bytes
         FROM dead_letters ORDER BY failed_at DESC, message_id DESC`,
      )
      .all() as unknown as readonly { readonly messageId: string; readonly bytes: number }[];
    let retainedBytes = 0;
    const remove = database.prepare("DELETE FROM dead_letters WHERE message_id = ?");
    for (const [index, row] of rows.entries()) {
      retainedBytes += row.bytes;
      if (
        index < DEFAULT_MEMORY_STORAGE_POLICY.deadLetterMaxEntries &&
        retainedBytes <= DEFAULT_MEMORY_STORAGE_POLICY.deadLetterMaxBytes
      ) {
        continue;
      }
      deleted += Number(remove.run(row.messageId).changes);
    }
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // No transaction remained active.
    }
    throw error;
  }
  if (deleted > 0) {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    database.exec("VACUUM;");
  }
  return deleted;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
