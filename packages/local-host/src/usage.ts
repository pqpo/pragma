import type {
  CanonicalEventFeed,
  CanonicalEventPage,
  RuntimeUsageObservation,
  UsageSink,
} from "@pragma/core";
import { RuntimeUsageObservedSchema } from "@pragma/core";
import { canonicalReceiptPage } from "./canonical-receipt-page.ts";
import { acquireHostStoragePool } from "./host-storage-pool.ts";

export interface LocalHostUsageSink extends UsageSink {
  list(): Promise<readonly RuntimeUsageObservation[]>;
  drain(): Promise<void>;
  close(): Promise<void>;
  start(): void;
  safeThrough(): number | undefined;
  inspect(): { state: "healthy" | "degraded"; pending: number; errorCode?: string | undefined };
}
interface ReceiptResult<T> {
  value: T;
  cursor: number;
  pending?: number;
  pendingDelta: number;
  errorCode?: string | undefined;
  errors: string[];
}

/** Durable source custody and incremental accounting, independent of answer completion. */
export function createLocalHostUsageSink(options: {
  path: string;
  feed?: CanonicalEventFeed | undefined;
  deliveryPath?: string | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): LocalHostUsageSink {
  const pool = acquireHostStoragePool();
  let closed = false;
  let stopping = true;
  let running: Promise<void> | undefined;
  let closeOperation: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let dirty = false;
  let retryMs = 500;
  let cursor: number | undefined;
  let pending = 0;
  let invalid: string | undefined;
  let lastError: string | undefined;
  const report = (code: string, cause?: unknown) => {
    lastError = code;
    try {
      options.onError?.(Object.assign(new Error(code, { cause }), { code }));
    } catch (error) {
      console.warn("USAGE_NOTIFICATION_FAILED", error);
    }
  };
  const ledger = async <T>(operation: string, input?: unknown): Promise<T> => {
    if (closed) throw new Error("Usage sink is closed.");
    return await pool.clients[1]!.call<T>(`usage-ledger:${operation}`, options.path, input);
  };
  const receipt = async <T>(operation: string, input?: unknown): Promise<T> => {
    const result = await pool.clients[1]!.call<ReceiptResult<T>>(
      `usage-receipt:${operation}`,
      options.deliveryPath!,
      input,
    );
    cursor = Math.max(cursor ?? 0, result.cursor);
    pending = result.pending ?? Math.max(0, pending + result.pendingDelta);
    invalid = result.errorCode;
    for (const code of result.errors) report(code);
    return result.value;
  };
  const stagePage = async (page: CanonicalEventPage): Promise<void> => {
    try {
      page = canonicalReceiptPage(page, false);
      await receipt("page", page);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "HOST_STORAGE_BACKPRESSURE" ||
        page.items.length < 2
      )
        throw error;
      const midpoint = Math.ceil(page.items.length / 2);
      const first = page.items.slice(0, midpoint);
      await stagePage({ items: first, nextCursor: first.at(-1)!.cursor });
      await stagePage({ items: page.items.slice(midpoint), nextCursor: page.nextCursor });
    }
  };
  const flush = async () => {
    if (options.feed === undefined || options.deliveryPath === undefined) return;
    const deadline = Date.now() + 5000;
    while (!stopping && Date.now() < deadline) {
      const rows = await receipt<{ id: string; payload: string }[]>("pending");
      let failed = false;
      for (const row of rows) {
        if (stopping) return;
        try {
          await ledger(
            "record",
            RuntimeUsageObservedSchema.shape.observation.parse(JSON.parse(row.payload)),
          );
          await receipt("ack", row.id);
        } catch (error) {
          failed = true;
          report("USAGE_DELIVERY_RETRY_PENDING", error);
        }
      }
      let page: Awaited<ReturnType<CanonicalEventFeed["read"]>>;
      try {
        page = await options.feed.read({ after: { sequence: cursor ?? 0 }, limit: 64 });
      } catch (error) {
        report("USAGE_DELIVERY_RECEIVE_FAILED", error);
        return;
      }
      if (page.items.length > 0) await stagePage(page);
      if (failed) return;
      lastError = undefined;
      if (page.items.length === 0 && rows.length < 64) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!stopping) dirty = true;
  };
  const run = (): Promise<void> => {
    if (running !== undefined) {
      dirty = true;
      return running;
    }
    if (timer !== undefined) clearTimeout(timer);
    dirty = false;
    const operation = flush()
      .catch((error) => {
        report("USAGE_DELIVERY_RECEIVE_FAILED", error);
        throw error;
      })
      .finally(() => {
        if (running === operation) running = undefined;
        if (!stopping) {
          retryMs = lastError === undefined ? 500 : Math.min(30_000, retryMs * 2);
          timer = setTimeout(
            wake,
            dirty && lastError === undefined ? 0 : lastError === undefined ? 30_000 : retryMs,
          );
          timer.unref();
        }
      });
    running = operation;
    return operation;
  };
  const wake = () => {
    if (!stopping && !closed)
      void run().catch(() => {
        /* run reports and retains durable custody. */
      });
  };
  const start = () => {
    if (closed) return;
    stopping = false;
    unsubscribe ??= options.feed?.subscribeChanges?.(wake);
    wake();
  };
  return {
    inspect: () => ({
      state: lastError === undefined && invalid === undefined ? "healthy" : "degraded",
      pending,
      errorCode: lastError ?? invalid,
    }),
    safeThrough: () => cursor,
    start,
    async record(observation) {
      if (closed) throw new Error("Usage sink is closed.");
      if (options.feed === undefined || options.deliveryPath === undefined)
        await ledger("record", observation);
      else start();
    },
    async list() {
      if (options.feed !== undefined) await this.drain();
      return await ledger("list");
    },
    async drain() {
      if (closed) return;
      stopping = false;
      await run();
    },
    close() {
      return (closeOperation ??= (async () => {
        stopping = true;
        closed = true;
        unsubscribe?.();
        if (timer !== undefined) clearTimeout(timer);
        try {
          await running;
        } finally {
          await pool.close();
        }
      })());
    },
  };
}
