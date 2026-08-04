import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  CanonicalEventEnvelopeSchema,
  type CanonicalEventCursor,
  type CanonicalEventEnvelope,
} from "@pragma/shared";

import { PragmaPaths } from "../storage/pragma-paths.ts";
import {
  CANONICAL_EVENT_FEED_V2_SCHEMA_SQL,
  migrateCanonicalEventFeedV1ToV2,
} from "../storage/migrations/canonical-event-feed/index.ts";
import { withFileLock } from "../storage/file-lock.ts";

export type CanonicalEventReadItem =
  | {
      readonly kind: "event";
      readonly cursor: CanonicalEventCursor;
      readonly event: CanonicalEventEnvelope;
    }
  | {
      readonly kind: "unreadable";
      readonly cursor: CanonicalEventCursor;
      readonly eventId?: string | undefined;
      readonly errorCode: "invalid_envelope";
    };

export interface CanonicalEventPage {
  readonly items: readonly CanonicalEventReadItem[];
  readonly nextCursor: CanonicalEventCursor;
}

export interface CanonicalEventFeedDiagnostic {
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly logicalBytes: number;
  readonly fileBytes: number;
  readonly receiptCount: number;
  readonly oldestOccurredAt?: string | undefined;
}

export interface CanonicalEventMaintenanceInput {
  readonly safeThrough: CanonicalEventCursor;
  readonly retainAfter: string;
  readonly targetBytes: number;
  readonly vacuumMinimumBytes?: number | undefined;
  readonly vacuumFreeRatio?: number | undefined;
}

export interface CanonicalEventMaintenanceResult {
  readonly deletedEvents: number;
  readonly reclaimedLogicalBytes: number;
  readonly vacuumed: boolean;
  readonly blockedBytes: number;
  readonly diagnostic: CanonicalEventFeedDiagnostic;
}

export interface CanonicalEventFeed {
  append(events: readonly CanonicalEventEnvelope[]): Promise<void>;
  read(input: {
    readonly after?: CanonicalEventCursor | undefined;
    readonly limit: number;
  }): Promise<CanonicalEventPage>;
  inspect(): Promise<CanonicalEventFeedDiagnostic>;
  maintain(input: CanonicalEventMaintenanceInput): Promise<CanonicalEventMaintenanceResult>;
  forgetCorrelation(correlationId: string): Promise<{ readonly deletedEvents: number }>;
  close(): void;
}

export async function createFileCanonicalEventFeed(
  options: { readonly pragmaHome?: string | undefined } = {},
): Promise<CanonicalEventFeed> {
  const paths = new PragmaPaths(options);
  const databasePath = paths.canonicalEventFeed();
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  await withFileLock(`${databasePath}.migration.lock`, async () => {
    if (readVersion(database) === 1) await ensureV1Backup(database, databasePath);
    initialize(database);
  });

  const inspect = (): CanonicalEventFeedDiagnostic => inspectDatabase(database);

  return {
    async append(events) {
      const parsed = events.map((event) => CanonicalEventEnvelopeSchema.parse(event));
      if (parsed.length === 0) return;
      const receipt = database.prepare("SELECT sequence FROM event_receipts WHERE event_id = ?");
      const existing = database.prepare("SELECT sequence FROM canonical_events WHERE event_id = ?");
      const insert = database.prepare(
        `INSERT INTO canonical_events(
           event_id, topic, schema_ref, correlation_id, occurred_at, envelope_bytes, envelope_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertReceipt = database.prepare(
        `INSERT OR IGNORE INTO event_receipts(
           event_id, sequence, correlation_id, source_type, source_id, source_cursor
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      database.exec("BEGIN IMMEDIATE;");
      try {
        let lastSequence = readLastSequence(database);
        for (const event of parsed) {
          if (receipt.get(event.eventId) !== undefined) continue;
          const alreadyStored = existing.get(event.eventId) as
            { readonly sequence: number } | undefined;
          let sequence = alreadyStored?.sequence;
          if (sequence === undefined) {
            const serialized = JSON.stringify(event);
            const result = insert.run(
              event.eventId,
              event.topic,
              event.schemaRef,
              event.correlationId ?? null,
              event.occurredAt,
              Buffer.byteLength(serialized),
              serialized,
            );
            sequence = Number(result.lastInsertRowid);
          }
          insertReceipt.run(
            event.eventId,
            sequence,
            event.correlationId ?? null,
            event.sourceRef.type,
            event.sourceRef.id,
            event.sourceRef.cursor ?? null,
          );
          lastSequence = Math.max(lastSequence, sequence);
        }
        writeLastSequence(database, lastSequence);
        database.exec("COMMIT;");
      } catch (error) {
        rollback(database);
        throw error;
      }
    },

    async read(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1_000) {
        throw new RangeError("Canonical event page limit must be between 1 and 1000.");
      }
      const after = input.after?.sequence ?? 0;
      const rows = database
        .prepare(
          "SELECT sequence, event_id AS eventId, envelope_json AS envelopeJson FROM canonical_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
        )
        .all(after, input.limit) as unknown as readonly {
        readonly sequence: number;
        readonly eventId: string;
        readonly envelopeJson: string;
      }[];
      const items = rows.map((row): CanonicalEventReadItem => {
        const cursor = { sequence: row.sequence };
        try {
          return {
            kind: "event",
            cursor,
            event: CanonicalEventEnvelopeSchema.parse(JSON.parse(row.envelopeJson)),
          };
        } catch {
          return {
            kind: "unreadable",
            cursor,
            eventId: row.eventId,
            errorCode: "invalid_envelope",
          };
        }
      });
      return {
        items,
        nextCursor: items.at(-1)?.cursor ?? { sequence: after },
      };
    },

    async inspect() {
      return inspect();
    },

    async maintain(input) {
      assertMaintenanceInput(input);
      const before = inspect();
      let deletedEvents = 0;
      let reclaimedLogicalBytes = 0;
      database.exec("BEGIN IMMEDIATE;");
      try {
        const expired = database
          .prepare(
            `SELECT sequence, COALESCE(envelope_bytes, length(CAST(envelope_json AS BLOB))) AS bytes
             FROM canonical_events
             WHERE sequence <= ? AND occurred_at < ?
             ORDER BY sequence`,
          )
          .all(input.safeThrough.sequence, input.retainAfter) as unknown as readonly {
          readonly sequence: number;
          readonly bytes: number;
        }[];
        const expiredSequences = new Set(expired.map((row) => row.sequence));
        let remainingBytes = before.logicalBytes - expired.reduce((sum, row) => sum + row.bytes, 0);
        const pressure: number[] = [];
        if (remainingBytes > input.targetBytes) {
          const candidates = database
            .prepare(
              `SELECT sequence, COALESCE(envelope_bytes, length(CAST(envelope_json AS BLOB))) AS bytes
               FROM canonical_events WHERE sequence <= ? ORDER BY sequence`,
            )
            .all(input.safeThrough.sequence) as unknown as readonly {
            readonly sequence: number;
            readonly bytes: number;
          }[];
          for (const candidate of candidates) {
            if (remainingBytes <= input.targetBytes) break;
            if (expiredSequences.has(candidate.sequence)) continue;
            pressure.push(candidate.sequence);
            remainingBytes -= candidate.bytes;
          }
        }
        const sequences = [...expiredSequences, ...pressure];
        const preserveReceipt = database.prepare(
          `INSERT OR IGNORE INTO event_receipts(
             event_id, sequence, correlation_id, source_type, source_id, source_cursor
           )
           SELECT event_id, sequence,
             COALESCE(correlation_id, json_extract(envelope_json, '$.correlationId')),
             json_extract(envelope_json, '$.sourceRef.type'),
             json_extract(envelope_json, '$.sourceRef.id'),
             json_extract(envelope_json, '$.sourceRef.cursor')
           FROM canonical_events WHERE sequence = ?`,
        );
        const remove = database.prepare("DELETE FROM canonical_events WHERE sequence = ?");
        for (const sequence of sequences) {
          const row = database
            .prepare(
              "SELECT COALESCE(envelope_bytes, length(CAST(envelope_json AS BLOB))) AS bytes FROM canonical_events WHERE sequence = ?",
            )
            .get(sequence) as { readonly bytes: number } | undefined;
          if (row === undefined) continue;
          preserveReceipt.run(sequence);
          remove.run(sequence);
          deletedEvents += 1;
          reclaimedLogicalBytes += row.bytes;
        }
        database.exec("COMMIT;");
      } catch (error) {
        rollback(database);
        throw error;
      }

      let vacuumed = false;
      const page = database.prepare("PRAGMA page_count").get() as unknown as {
        readonly page_count: number;
      };
      const free = database.prepare("PRAGMA freelist_count").get() as unknown as {
        readonly freelist_count: number;
      };
      const size = database.prepare("PRAGMA page_size").get() as unknown as {
        readonly page_size: number;
      };
      const freeBytes = free.freelist_count * size.page_size;
      if (
        freeBytes >= (input.vacuumMinimumBytes ?? 64 * 1_024 * 1_024) &&
        free.freelist_count / Math.max(1, page.page_count) >= (input.vacuumFreeRatio ?? 0.25)
      ) {
        database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        database.exec("VACUUM;");
        vacuumed = true;
      }
      const diagnostic = inspect();
      await removeExpiredV1Backup(databasePath, Date.parse(input.retainAfter));
      return {
        deletedEvents,
        reclaimedLogicalBytes,
        vacuumed,
        blockedBytes: Math.max(0, diagnostic.logicalBytes - input.targetBytes),
        diagnostic,
      };
    },

    async forgetCorrelation(correlationId) {
      if (correlationId.trim() === "") throw new TypeError("Correlation id is required.");
      database.exec("BEGIN IMMEDIATE;");
      try {
        const result = database
          .prepare(
            `DELETE FROM canonical_events
             WHERE correlation_id = ? OR
               (correlation_id IS NULL AND json_extract(envelope_json, '$.correlationId') = ?)`,
          )
          .run(correlationId, correlationId);
        database.prepare("DELETE FROM event_receipts WHERE correlation_id = ?").run(correlationId);
        database.exec("COMMIT;");
        return { deletedEvents: Number(result.changes) };
      } catch (error) {
        rollback(database);
        throw error;
      }
    },

    close() {
      database.close();
    },
  };
}

async function ensureV1Backup(database: DatabaseSync, databasePath: string): Promise<void> {
  const destination = `${databasePath}.v1.backup`;
  try {
    await stat(destination);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${destination}.tmp`;
  await rm(temporary, { force: true });
  await backup(database, temporary);
  await rename(temporary, destination);
}

async function removeExpiredV1Backup(databasePath: string, cutoff: number): Promise<void> {
  const path = `${databasePath}.v1.backup`;
  try {
    if ((await stat(path)).mtimeMs <= cutoff) await rm(path, { force: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function initialize(database: DatabaseSync): void {
  const version = readVersion(database);
  if (version > 2) {
    database.close();
    throw new Error(`unsupported-state-version:pragma.canonical-event-feed/v${version}`);
  }
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  if (version === 0) {
    database.exec(CANONICAL_EVENT_FEED_V2_SCHEMA_SQL);
    return;
  }
  if (version === 1) {
    migrateCanonicalEventFeedV1ToV2(database);
  }
}

function inspectDatabase(database: DatabaseSync): CanonicalEventFeedDiagnostic {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS eventCount,
         COALESCE(SUM(COALESCE(envelope_bytes, length(CAST(envelope_json AS BLOB)))), 0) AS logicalBytes,
         MIN(occurred_at) AS oldestOccurredAt
       FROM canonical_events`,
    )
    .get() as unknown as {
    readonly eventCount: number;
    readonly logicalBytes: number;
    readonly oldestOccurredAt: string | null;
  };
  const receipts = database
    .prepare("SELECT COUNT(*) AS count FROM event_receipts")
    .get() as unknown as {
    readonly count: number;
  };
  const pages = database.prepare("PRAGMA page_count").get() as unknown as {
    readonly page_count: number;
  };
  const pageSize = database.prepare("PRAGMA page_size").get() as unknown as {
    readonly page_size: number;
  };
  return {
    lastSequence: readLastSequence(database),
    eventCount: row.eventCount,
    logicalBytes: row.logicalBytes,
    fileBytes: pages.page_count * pageSize.page_size,
    receiptCount: receipts.count,
    ...(row.oldestOccurredAt === null ? {} : { oldestOccurredAt: row.oldestOccurredAt }),
  };
}

function assertMaintenanceInput(input: CanonicalEventMaintenanceInput): void {
  if (!Number.isSafeInteger(input.safeThrough.sequence) || input.safeThrough.sequence < 0) {
    throw new RangeError("Canonical event safe sequence must be non-negative.");
  }
  if (Number.isNaN(Date.parse(input.retainAfter))) {
    throw new TypeError("Canonical event retention cutoff must be an ISO date.");
  }
  if (!Number.isSafeInteger(input.targetBytes) || input.targetBytes < 0) {
    throw new RangeError("Canonical event target bytes must be non-negative.");
  }
}

function readVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  return row.user_version;
}

function readLastSequence(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT value FROM feed_metadata WHERE key = 'last_sequence'")
    .get() as { readonly value: string } | undefined;
  return row === undefined ? 0 : Number(row.value);
}

function writeLastSequence(database: DatabaseSync, sequence: number): void {
  database
    .prepare(
      `INSERT INTO feed_metadata(key, value) VALUES ('last_sequence', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(String(sequence));
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK;");
  } catch {
    // No transaction remained active.
  }
}
