import type { UsageUpdate } from "@pragma/shared";
import type {
  DesktopUsageStore as UsageDatabaseStore,
  UsageObservationContext,
} from "./usage-database.ts";
import { acquireHostStoragePool } from "./host-storage-pool.ts";
export type { UsageObservationContext };

type AsyncMethods = {
  [
    K in Exclude<keyof UsageDatabaseStore, "trackingStartedAt" | "subscribe">
  ]: UsageDatabaseStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
export type HostUsageStore = AsyncMethods & {
  readonly trackingStartedAt: string;
  subscribe(listener: (update: UsageUpdate) => void): () => void;
  start(): Promise<void>;
};

/** The two Host workers own all SQL; Main only forwards finite domain operations. */
export async function createHostUsageStore(input: {
  databasePath: string;
  now?: Date | undefined;
  timezone?: string | undefined;
  deferred?: boolean | undefined;
}): Promise<HostUsageStore> {
  const pool = acquireHostStoragePool();
  const listeners = new Set<(update: UsageUpdate) => void>();
  let trackingStartedAt = (input.now ?? new Date()).toISOString();
  let initialization: Promise<void> | undefined;
  let initializedGeneration: number | undefined;
  let closed = false;
  const activeCalls = new Set<Promise<unknown>>();
  const init = () => {
    if (
      initializedGeneration !== undefined &&
      initializedGeneration !== pool.clients[1]!.generation()
    ) {
      initialization = undefined;
      initializedGeneration = undefined;
    }
    return (initialization ??= pool.clients[1]!.call<string>(
      "usage:open",
      input.databasePath,
      input,
    )
      .then((value) => {
        trackingStartedAt = value;
        initializedGeneration = pool.clients[1]!.generation();
      })
      .catch((error) => {
        initialization = undefined;
        throw error;
      }));
  };
  const call = <T>(method: string, args: unknown[]): Promise<T> => {
    if (closed) return Promise.reject(new Error("Usage store is closed."));
    const operation = (async () => {
      await init();
      const result = await pool.clients[1]!.call<{ value: T; updates: UsageUpdate[] }>(
        `usage:${method}`,
        input.databasePath,
        args,
      ).catch((error) => {
        if (
          ["HOST_STORAGE_WORKER_UNAVAILABLE", "USAGE_DATABASE_NOT_INITIALIZED"].includes(
            String((error as { code?: string }).code),
          )
        ) {
          initialization = undefined;
          initializedGeneration = undefined;
        }
        throw error;
      });
      for (const update of result.updates)
        for (const listener of listeners) {
          try {
            listener(update);
          } catch (error) {
            process.emitWarning(`Usage notification failed: ${String(error)}`, {
              code: "USAGE_NOTIFICATION_FAILED",
            });
          }
        }
      return result.value;
    })();
    activeCalls.add(operation);
    void operation.then(
      () => activeCalls.delete(operation),
      () => activeCalls.delete(operation),
    );
    return operation;
  };
  let closeOperation: Promise<void> | undefined;
  const store: HostUsageStore = {
    get trackingStartedAt() {
      return trackingStartedAt;
    },
    start: async () => {
      if (!closed) await init();
    },
    assertAvailable: async () => {
      await call("assertAvailable", []);
    },
    record: async (...args) => {
      await call("record", args);
    },
    recordRecovered: async (...args) => {
      await call("recordRecovered", args);
    },
    getOverview: async (...args) => await call("getOverview", args),
    listSubjects: async (...args) => await call("listSubjects", args),
    getMissionUsage: async (...args) => await call("getMissionUsage", args),
    markSubjectDeleted: async (...args) => {
      await call("markSubjectDeleted", args);
    },
    reconcileActiveSubjects: async (...args) => {
      await call("reconcileActiveSubjects", args);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      return (closeOperation ??= (async () => {
        closed = true;
        try {
          await Promise.allSettled([...activeCalls]);
          if (initialization !== undefined) {
            await initialization;
            if (initializedGeneration === pool.clients[1]!.generation())
              await pool.clients[1]!.call("usage:close", input.databasePath);
          }
        } finally {
          listeners.clear();
          await pool.close();
        }
      })());
    },
  };
  if (!input.deferred) {
    try {
      await init();
    } catch (error) {
      await pool.close();
      throw error;
    }
  }
  return store;
}
