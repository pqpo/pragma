import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ExecutionEventSchema } from "@pragma/shared";

import {
  withFileLock,
  type RuntimeUsageObservation,
  type UsageSink,
  RuntimeUsageObservedSchema,
  type CanonicalEventFeed,
} from "@pragma/core";

const USAGE_SCHEMA_VERSION = "pragma.local-host-usage/v1" as const;

interface UsageLedger {
  readonly schemaVersion: typeof USAGE_SCHEMA_VERSION;
  readonly observations: Readonly<Record<string, RuntimeUsageObservation>>;
}

export interface LocalHostUsageSink extends UsageSink {
  readonly list: () => Promise<readonly RuntimeUsageObservation[]>;
  readonly drain: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly start: () => void;
  readonly safeThrough: () => number | undefined;
  readonly inspect: () => {
    state: "healthy" | "degraded";
    pending: number;
    errorCode?: string | undefined;
  };
}

/**
 * Durable Host usage sink. Observation IDs are the idempotency key, while a
 * conflicting payload is treated as corruption rather than double-counted.
 */
export function createLocalHostUsageSink(options: {
  readonly path: string;
  readonly feed?: CanonicalEventFeed | undefined;
  readonly deliveryPath?: string | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}): LocalHostUsageSink {
  const lockPath = `${options.path}.lock`;
  const readLedger = async (): Promise<UsageLedger> => {
    try {
      const parsed = JSON.parse(await readFile(options.path, "utf8")) as Partial<UsageLedger>;
      if (parsed.schemaVersion !== USAGE_SCHEMA_VERSION || parsed.observations === undefined) {
        throw new Error("Unsupported Local Host usage ledger.");
      }
      return {
        schemaVersion: USAGE_SCHEMA_VERSION,
        observations: parsed.observations,
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return { schemaVersion: USAGE_SCHEMA_VERSION, observations: {} };
      }
      throw error;
    }
  };
  const writeLedger = async (ledger: UsageLedger): Promise<void> => {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    const temporary = `${options.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    await rename(temporary, options.path);
  };

  const sink: LocalHostUsageSink = {
    inspect: () => ({ state: "healthy", pending: 0 }),
    start: () => undefined,
    safeThrough: () => undefined,
    drain: async () => undefined,
    close: async () => undefined,
    async record(observation) {
      await withFileLock(
        lockPath,
        async () => {
          const ledger = await readLedger();
          const existing = ledger.observations[observation.observationId];
          if (existing !== undefined) {
            if (observationSignature(existing) !== observationSignature(observation)) {
              throw new Error(`Conflicting usage observation: ${observation.observationId}.`);
            }
            return;
          }
          await writeLedger({
            schemaVersion: USAGE_SCHEMA_VERSION,
            observations: {
              ...ledger.observations,
              [observation.observationId]: observation,
            },
          });
        },
        { operation: "local-host-usage" },
      );
    },
    async list() {
      const ledger = await readLedger();
      return Object.values(ledger.observations).toSorted((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt),
      );
    },
  };
  if (options.feed === undefined || options.deliveryPath === undefined) return sink;
  return createSourceUsageSink(sink, {
    feed: options.feed,
    path: options.deliveryPath,
    onError: options.onError,
  });
}

/** The receipt database stages observations before advancing the shared Feed watermark. */
function createSourceUsageSink(
  sink: LocalHostUsageSink,
  options: {
    feed: CanonicalEventFeed;
    path: string;
    onError?: ((error: unknown) => void) | undefined;
  },
): LocalHostUsageSink {
  let database: Promise<DatabaseSync> | undefined;
  let receipt: DatabaseSync | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let lastError: string | undefined;
  const open = () =>
    (database ??= (async () => {
      await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(options.path);
      try {
        const exists = db
          .prepare("SELECT name FROM sqlite_master WHERE name='usage_delivery_metadata'")
          .get();
        if (exists !== undefined) {
          const version = db
            .prepare("SELECT value FROM usage_delivery_metadata WHERE key='version'")
            .get() as { value: string } | undefined;
          if (version?.value !== "pragma.local-host-usage-delivery/v1") {
            throw new Error("Unsupported usage delivery version.");
          }
        }
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS usage_delivery_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO usage_delivery_metadata VALUES('version','pragma.local-host-usage-delivery/v1');
      INSERT OR IGNORE INTO usage_delivery_metadata VALUES('cursor','0');
      CREATE TABLE IF NOT EXISTS usage_delivery_pending(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_delivery_quarantine(id TEXT PRIMARY KEY,payload TEXT NOT NULL,error_code TEXT NOT NULL);`);
        receipt = db;
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    })().catch((error: unknown) => {
      database = undefined;
      throw error;
    }));
  const flush = async () => {
    const db = await open();
    const deadline = Date.now() + 5000;
    while (!stopping && Date.now() < deadline) {
      // Flush observations already under receipt custody before requiring the
      // source. A failed intake must not prevent a repaired ledger from draining.
      const rows = db.prepare("SELECT id,payload FROM usage_delivery_pending LIMIT 64").all() as {
        id: string;
        payload: string;
      }[];
      let failed = false;
      for (const row of rows) {
        if (stopping || Date.now() >= deadline) return;
        try {
          await sink.record(
            RuntimeUsageObservedSchema.shape.observation.parse(JSON.parse(row.payload)),
          );
          db.prepare("DELETE FROM usage_delivery_pending WHERE id=?").run(row.id);
        } catch (error) {
          failed = true;
          lastError = "USAGE_DELIVERY_RETRY_PENDING";
          options.onError?.(error);
        }
      }
      if (stopping || Date.now() >= deadline) return;
      if (rows.length === 64 && !failed) continue;
      const after = Number(
        (
          db.prepare("SELECT value FROM usage_delivery_metadata WHERE key='cursor'").get() as {
            value: string;
          }
        ).value,
      );
      let page: Awaited<ReturnType<CanonicalEventFeed["read"]>>;
      try {
        page = await options.feed.read({ after: { sequence: after }, limit: 64 });
      } catch (error) {
        lastError = "USAGE_DELIVERY_RECEIVE_FAILED";
        options.onError?.(error);
        return;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const received = Number(
          (
            db.prepare("SELECT value FROM usage_delivery_metadata WHERE key='cursor'").get() as {
              value: string;
            }
          ).value,
        );
        for (const item of page.items) {
          if (item.cursor.sequence <= received) continue;
          if (item.kind !== "event") {
            db.prepare("INSERT OR IGNORE INTO usage_delivery_quarantine VALUES(?,?,?)").run(
              `unreadable:${item.cursor.sequence}`,
              JSON.stringify(item),
              "USAGE_DELIVERY_INVALID_ENVELOPE",
            );
            options.onError?.(
              Object.assign(new Error("Unreadable usage source retained"), {
                code: "USAGE_DELIVERY_INVALID_ENVELOPE",
              }),
            );
            continue;
          }
          if (item.event.topic !== "pragma.execution.event.committed") continue;
          const parsed = ExecutionEventSchema.safeParse(item.event.payload);
          if (parsed.success && parsed.data.type !== "runtime.usage.observed") continue;
          const usage = parsed.success
            ? RuntimeUsageObservedSchema.safeParse(parsed.data.data)
            : undefined;
          if (
            usage === undefined ||
            !usage.success ||
            !parsed.success ||
            usage.data.observation.executionId !== parsed.data.executionId ||
            usage.data.observation.invocationId !== parsed.data.invocationId
          ) {
            db.prepare("INSERT OR IGNORE INTO usage_delivery_quarantine VALUES(?,?,?)").run(
              item.event.eventId,
              JSON.stringify(item.event.payload),
              "USAGE_DELIVERY_INVALID_FACT",
            );
            options.onError?.(
              Object.assign(new Error("Invalid usage fact retained"), {
                code: "USAGE_DELIVERY_INVALID_FACT",
              }),
            );
            continue;
          }
          const { observation } = usage.data;
          db.prepare("INSERT OR IGNORE INTO usage_delivery_pending VALUES(?,?)").run(
            observation.observationId,
            JSON.stringify(observation),
          );
        }
        const current = Number(
          (
            db.prepare("SELECT value FROM usage_delivery_metadata WHERE key='cursor'").get() as {
              value: string;
            }
          ).value,
        );
        db.prepare("UPDATE usage_delivery_metadata SET value=? WHERE key='cursor'").run(
          String(Math.max(current, page.nextCursor.sequence)),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // A ledger failure does not prevent taking custody of this source page.
      if (failed) return;
      lastError = undefined;
      if (page.items.length === 0) return;
    }
  };
  const runFlush = (): Promise<void> => {
    if (closing !== undefined) return closing;
    if (running !== undefined) return running;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const operation = flush().finally(() => {
      if (running === operation) running = undefined;
      if (!stopping) {
        timer = setTimeout(wake, 500);
        timer.unref();
      }
    });
    running = operation;
    return operation;
  };
  const wake = () => {
    if (stopping || closing !== undefined) return;
    void runFlush().catch((error: unknown) => {
      lastError = "USAGE_DELIVERY_RECEIVE_FAILED";
      options.onError?.(error);
    });
  };
  return {
    inspect() {
      const invalid = receipt
        ?.prepare("SELECT error_code FROM usage_delivery_quarantine LIMIT 1")
        .get() as { error_code: string } | undefined;
      const pending =
        receipt === undefined
          ? 0
          : Number(
              (
                receipt.prepare("SELECT COUNT(*) AS count FROM usage_delivery_pending").get() as {
                  count: number;
                }
              ).count,
            );
      return {
        state:
          lastError === undefined && invalid === undefined
            ? ("healthy" as const)
            : ("degraded" as const),
        pending,
        errorCode: lastError ?? invalid?.error_code,
      };
    },
    start() {
      if (closing !== undefined) return;
      stopping = false;
      wake();
    },
    safeThrough() {
      return receipt === undefined
        ? undefined
        : Number(
            (
              receipt
                .prepare("SELECT value FROM usage_delivery_metadata WHERE key='cursor'")
                .get() as { value: string }
            ).value,
          );
    },
    record() {
      if (closing !== undefined) return;
      stopping = false;
      wake();
    },
    async list() {
      await this.drain();
      return await sink.list();
    },
    async drain() {
      if (closing !== undefined) return await closing;
      stopping = false;
      await runFlush();
    },
    async close() {
      if (closing !== undefined) return await closing;
      if (timer !== undefined) clearTimeout(timer);
      stopping = true;
      const operation = (async () => {
        try {
          await running;
        } finally {
          receipt?.close();
          database = undefined;
          receipt = undefined;
        }
      })();
      closing = operation;
      try {
        await operation;
      } finally {
        if (closing === operation) closing = undefined;
      }
    },
  };
}

function observationSignature(observation: RuntimeUsageObservation): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        observationId: observation.observationId,
        occurredAt: observation.occurredAt,
        executionId: observation.executionId,
        invocationId: observation.invocationId,
        contextId: observation.contextId,
        runId: observation.runId,
        runtimeId: observation.runtimeId,
        modelSelection: observation.modelSelection,
        executor: observation.executor,
        usage: observation.usage,
      }),
    )
    .digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
