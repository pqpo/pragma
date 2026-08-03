import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CanonicalEventEnvelopeSchema,
  type CanonicalEventCursor,
  type CanonicalEventEnvelope,
} from "@pragma/shared";

import { PragmaPaths } from "../storage/pragma-paths.ts";

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
}

export interface CanonicalEventFeed {
  append(events: readonly CanonicalEventEnvelope[]): Promise<void>;
  read(input: {
    readonly after?: CanonicalEventCursor | undefined;
    readonly limit: number;
  }): Promise<CanonicalEventPage>;
  inspect(): Promise<CanonicalEventFeedDiagnostic>;
  close(): void;
}

export async function createFileCanonicalEventFeed(
  options: { readonly pragmaHome?: string | undefined } = {},
): Promise<CanonicalEventFeed> {
  const paths = new PragmaPaths(options);
  const databasePath = paths.canonicalEventFeed();
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  initialize(database);

  return {
    async append(events) {
      const parsed = events.map((event) => CanonicalEventEnvelopeSchema.parse(event));
      if (parsed.length === 0) return;
      const insert = database.prepare(
        "INSERT OR IGNORE INTO canonical_events(event_id, topic, schema_ref, occurred_at, envelope_json) VALUES (?, ?, ?, ?, ?)",
      );
      database.exec("BEGIN IMMEDIATE;");
      try {
        for (const event of parsed) {
          insert.run(
            event.eventId,
            event.topic,
            event.schemaRef,
            event.occurredAt,
            JSON.stringify(event),
          );
        }
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
      const row = database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS lastSequence, COUNT(*) AS eventCount FROM canonical_events",
        )
        .get() as unknown as { readonly lastSequence: number; readonly eventCount: number };
      return row;
    },

    close() {
      database.close();
    },
  };
}

function initialize(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  if (version.user_version > 1) {
    database.close();
    throw new Error(
      `unsupported-state-version:pragma.canonical-event-feed/v${version.user_version}`,
    );
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS canonical_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL,
      schema_ref TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS canonical_events_topic_sequence
      ON canonical_events(topic, sequence);
    PRAGMA user_version = 1;
  `);
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK;");
  } catch {
    // No transaction remained active.
  }
}
