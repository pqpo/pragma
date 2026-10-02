import {
  ExecutionStorageExportSchema,
  type ExecutionStorageExport,
} from "./execution-storage-export.ts";
import { acquireHostStoragePool } from "../host-storage-pool.ts";
import { readdir, readFile, rm, mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  PragmaPaths,
  decodePragmaPathSegment,
  encodePragmaPathSegment,
  withFileLock,
  getExecutionLiveBus,
  ExecutionVersionConflictError,
  EXECUTION_RECOVERY_CLAIM_STATE_KEY,
  type DurableExecutionStore,
  type CanonicalEventFeed,
  type PragmaLogger,
  type ExecutionCommitResult,
} from "@pragma/core";
import {
  CanonicalEventEnvelopeSchema,
  type CanonicalEventEnvelope,
  type ExecutionEvent,
} from "@pragma/shared";

/** Node Host adapter. Normal transactions touch only changed rows and new events. */
export function createSqliteExecutionStore(
  options: {
    pragmaHome?: string | undefined;
    canonicalEventFeed?: CanonicalEventFeed | undefined;
    logger?: PragmaLogger | undefined;
  } = {},
): DurableExecutionStore & {
  close(): Promise<void>;
  prepareOwner(id: string): Promise<boolean>;
  exportSnapshot(id: string): Promise<ExecutionStorageExport>;
} {
  const paths = new PragmaPaths(options);
  const pool = acquireHostStoragePool();
  const clients = pool.clients;
  const deleting = new Set<string>();
  const deliveries = new Map<string, Promise<void>>();
  const scheduledDeliveries = new Map<string, ReturnType<typeof setTimeout>>();
  const dirtyDeliveries = new Set<string>();
  let closing = false;
  let closeRequested = false;
  const activeCalls = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    activeCalls.add(operation);
    void operation.then(
      () => activeCalls.delete(operation),
      () => activeCalls.delete(operation),
    );
    return operation;
  };
  let closeOperation: Promise<void> | undefined;
  // Prepared owners and necessary custody RPCs never wait behind conversion.
  const workerFor = () => clients[0]!;
  const call = <T>(
    operation: string,
    id: string,
    input?: unknown,
    internal = false,
  ): Promise<T> => {
    if (closing || (closeRequested && !internal))
      return Promise.reject(new Error("Execution store is closed."));
    if (deleting.has(id))
      return Promise.reject(new Error(`Execution deletion is in progress: ${id}`));
    return track(
      (async () => {
        const send = () =>
          pool.execute<T>(
            operation,
            id,
            input,
            options.canonicalEventFeed !== undefined,
            paths.root,
          );
        let retryMs = 5;
        for (;;) {
          try {
            try {
              return await send();
            } catch (error) {
              if ((error as { code?: string }).code !== "EXECUTION_OWNER_PREPARATION_REQUIRED")
                throw error;
              await pool.prepare(paths.root, id);
              return await send();
            }
          } catch (error) {
            if (
              (error as { code?: string }).code !== "HOST_STORAGE_BACKPRESSURE" ||
              closing ||
              deleting.has(id)
            )
              throw error;
            // Necessary facts remain with the caller while a bounded worker
            // queue drains; capacity contention is not a failed Runtime turn.
            await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
            retryMs = Math.min(200, retryMs * 2);
          }
        }
      })(),
    );
  };
  const deliver = (id: string, prepareLegacy = false): Promise<void> => {
    const running = deliveries.get(id);
    if (running !== undefined) return running;
    if (options.canonicalEventFeed === undefined) return Promise.resolve();
    const operation = withFileLock(
      paths.canonicalEventDeliveryLock(id),
      async () => {
        while (!deleting.has(id) && !closing) {
          dirtyDeliveries.delete(id);
          let events = await call<CanonicalEventEnvelope[] | undefined>(
            "outbox",
            id,
            undefined,
            true,
          );
          if (events === undefined && prepareLegacy) {
            prepareLegacy = false;
            await pool.prepare(paths.root, id);
            events = await call<CanonicalEventEnvelope[] | undefined>(
              "outbox",
              id,
              undefined,
              true,
            );
          }
          if (events === undefined) {
            throw new Error(`EXECUTION_CANONICAL_OWNER_UNAVAILABLE:${id}`);
          }
          if (events.length === 0) {
            await call("ack", id, [], true);
            if (dirtyDeliveries.has(id)) continue;
            return;
          }
          await options.canonicalEventFeed!.append(
            events.map((event) => CanonicalEventEnvelopeSchema.parse(event)),
          );
          const pending = await call<boolean>(
            "ack",
            id,
            events.map((event) => event.eventId),
            true,
          );
          if (!pending && !dirtyDeliveries.has(id)) return;
          // A background batch cannot hold the owner lock during feed I/O.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      },
      { operation: "execution.sqlite.delivery" },
    ).finally(() => {
      if (deliveries.get(id) === operation) deliveries.delete(id);
      if (dirtyDeliveries.delete(id) && !deleting.has(id) && !closing) wake(id);
    });
    deliveries.set(id, operation);
    return operation;
  };
  const dispatchDelivery = (id: string) => {
    if (deliveries.has(id)) {
      dirtyDeliveries.add(id);
      return;
    }
    void deliver(id).catch((error) =>
      options.logger?.warn(
        "execution.canonical_delivery_deferred",
        "Canonical source retained for retry.",
        { executionId: id, error, errorCode: "execution_canonical_delivery_failed" },
      ),
    );
  };
  const cancelScheduledDelivery = (id: string) => {
    const timer = scheduledDeliveries.get(id);
    if (timer !== undefined) clearTimeout(timer);
    scheduledDeliveries.delete(id);
  };
  const wake = (id: string) => {
    if (options.canonicalEventFeed === undefined || deleting.has(id) || closing) return;
    if (deliveries.has(id) || closeRequested) {
      cancelScheduledDelivery(id);
      dispatchDelivery(id);
      return;
    }
    if (scheduledDeliveries.has(id)) return;
    if (scheduledDeliveries.size >= 128) {
      dispatchDelivery(id);
      return;
    }
    // Custody is already durable in the outbox. Coalesce product projection
    // work so every small foreground commit does not retire and re-register
    // the same canonical source. Explicit drain bypasses this delay.
    const timer = setTimeout(() => {
      scheduledDeliveries.delete(id);
      if (!deleting.has(id) && !closing) dispatchDelivery(id);
    }, 250);
    timer.unref();
    scheduledDeliveries.set(id, timer);
  };
  const directoryNames = async (directory: string): Promise<string[]> => {
    try {
      return await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  // Background discovery only. Interactive owner operations never invoke this scan.
  let historicalSources = new Set<string>();
  const pendingIds = async () => {
    const historicalIds = new Set<string>();
    const ids = new Set<string>();
    for (const [directory, historical] of [
      [paths.executionCanonicalPendingRoot(), false],
      [paths.canonicalEventHandoffsRoot(), true],
    ] as const) {
      for (const name of await directoryNames(directory)) {
        if (!name.endsWith(".json")) continue;
        try {
          const id = decodePragmaPathSegment(historical ? name.split(".")[0]! : name.slice(0, -5));
          ids.add(id);
          if (historical) historicalIds.add(id);
        } catch (error) {
          const root = paths.canonicalEventHandoffQuarantineRoot();
          try {
            await mkdir(root, { recursive: true, mode: 0o700 });
            await rename(join(directory, name), join(root, `${name}.${randomUUID()}.blocked`));
          } catch (quarantineError) {
            if ((quarantineError as NodeJS.ErrnoException).code === "ENOENT") continue;
            options.logger?.warn(
              "execution.canonical_quarantine_failed",
              "Invalid source retained for repair.",
              {
                error: quarantineError,
                errorCode: "execution_canonical_quarantine_failed",
              },
            );
          }
          options.logger?.warn(
            "execution.canonical_source_invalid",
            "Invalid canonical owner source isolated.",
            {
              error,
              errorCode: "execution_canonical_source_invalid",
            },
          );
        }
      }
    }
    historicalSources = historicalIds;
    return [...ids].sort();
  };
  let recoveryCursor: string | undefined;
  const recoveryRetries = new Map<string, { attempts: number; nextAt: number }>();
  let recoveryOperation:
    | Promise<{ recovered: number; pending: number; failed: number; quarantined: number }>
    | undefined;
  const quarantinedCount = async () =>
    (await directoryNames(paths.canonicalEventHandoffQuarantineRoot())).length;
  const store: DurableExecutionStore & {
    close(): Promise<void>;
    prepareOwner(id: string): Promise<boolean>;
    exportSnapshot(id: string): Promise<ExecutionStorageExport>;
  } = {
    prepareOwner: async (id) => {
      if (closeRequested) throw new Error("Execution store is closed.");
      return await track(pool.prepare(paths.root, id));
    },
    exportSnapshot: async (id) => ExecutionStorageExportSchema.parse(await call("export", id)),
    create: async (record, root) => await call("create", record.executionId, { record, root }),
    get: async (id) => await call("get", id),
    getPrepared: async (id) => await call("get-prepared", id),
    async commit(request) {
      const { publishedEvents, ...result } = await call<
        ExecutionCommitResult & { publishedEvents: ExecutionEvent[] }
      >("commit", request.executionId, request);
      for (const event of publishedEvents)
        getExecutionLiveBus(store).publishEvent(request.executionId, event);
      if ((request.events?.length ?? 0) > 0) wake(request.executionId);
      return result;
    },
    getInvocation: async (id, key) => await call("get-invocation", id, key),
    getAgent: async (id, key) => await call("get-agent", id, key),
    getContext: async (id, key) => await call("get-context", id, key),
    listInvocations: async (id) => (await call("list-invocations", id)) ?? [],
    listAgents: async (id) => (await call("list-agents", id)) ?? [],
    listContexts: async (id) => (await call("list-contexts", id)) ?? [],
    getTree: async (id) => await call("tree", id),
    readEvents: async (id, after, limit) => (await call("events", id, { after, limit })) ?? [],
    async claimRecovery(id, claimId, leaseMs) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await store.get(id);
        if (current === undefined) throw new Error(`Execution not found: ${id}`);
        const claim = current.state[EXECUTION_RECOVERY_CLAIM_STATE_KEY] as
          { claimId?: string; expiresAt?: string; processId?: number } | undefined;
        let alive = true;
        if (claim?.processId !== undefined)
          try {
            process.kill(claim.processId, 0);
          } catch (error) {
            alive = (error as NodeJS.ErrnoException).code === "EPERM";
          }
        if (
          claim?.claimId !== undefined &&
          claim.claimId !== claimId &&
          Date.parse(claim.expiresAt ?? "") > Date.now() &&
          alive
        )
          return false;
        try {
          await store.commit({
            executionId: id,
            commitId: `claim-recovery:${claimId}:${current.version}`,
            expectedVersion: current.version,
            executionPatch: {
              state: {
                ...current.state,
                [EXECUTION_RECOVERY_CLAIM_STATE_KEY]: {
                  claimId,
                  processId: process.pid,
                  expiresAt: new Date(Date.now() + leaseMs).toISOString(),
                },
              },
            },
          });
          return true;
        } catch (error) {
          if (!(error instanceof ExecutionVersionConflictError) || attempt === 7) throw error;
        }
      }
      throw new Error("Execution recovery claim retries exhausted.");
    },
    async releaseWaitingHumanRecovery(id, claimId) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await store.get(id);
        if (current === undefined) throw new Error(`Execution not found: ${id}`);
        const claim = current.state[EXECUTION_RECOVERY_CLAIM_STATE_KEY] as
          { claimId?: string; expiresAt?: string } | undefined;
        if (
          current.status !== "waiting" ||
          claim?.claimId !== claimId ||
          Date.parse(claim.expiresAt ?? "") <= Date.now() ||
          !(await store.listInvocations(id)).some(
            (value) => value.status === "waiting" && value.waitReason === "human_input",
          )
        )
          throw new Error("Execution has no owned human recovery claim.");
        const state = { ...current.state };
        delete state[EXECUTION_RECOVERY_CLAIM_STATE_KEY];
        try {
          await store.commit({
            executionId: id,
            commitId: `release-waiting-human-recovery:${claimId}`,
            expectedVersion: current.version,
            executionPatch: { state },
          });
          return;
        } catch (error) {
          if (!(error instanceof ExecutionVersionConflictError) || attempt === 7) throw error;
        }
      }
    },
    archive: async (id) => await call("archive", id),
    async delete(id) {
      await store.withCanonicalEventDeletion([id], async (pendingFiles) => {
        await rm(paths.executionRoot(id), { recursive: true, force: true });
        await rm(paths.executionArchive(id), { force: true });
        for (const file of pendingFiles) await rm(file, { force: true });
      });
    },
    async withCanonicalEventDeletion(ids, action, expertSessionIds = []) {
      return await withFileLock(
        paths.executionDeletionBarrierLock(),
        async () => {
          const ordered = [...new Set(ids)].sort();
          const sessions = [...new Set(expertSessionIds)].sort();
          for (const id of ordered) {
            deleting.add(id);
            cancelScheduledDelivery(id);
          }
          const acquire = async (
            index: number,
            executionLocks: boolean,
          ): Promise<Awaited<ReturnType<typeof action>>> => {
            const id = ordered[index];
            if (id !== undefined)
              return await withFileLock(
                executionLocks ? paths.executionLock(id) : paths.canonicalEventDeliveryLock(id),
                () => acquire(index + 1, executionLocks),
                {
                  operation: executionLocks
                    ? "execution.deletion-barrier"
                    : "execution.canonical-deletion",
                },
              );
            if (!executionLocks) {
              for (const id of ordered)
                await workerFor().call("close-owner", id, undefined, false, paths.root);
              return await acquire(0, true);
            }
            const files: string[] = [];
            for (const id of ordered)
              if (
                await readFile(paths.executionCanonicalPending(id)).then(
                  () => true,
                  (error) => {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                    throw error;
                  },
                )
              )
                files.push(paths.executionCanonicalPending(id));
            for (const directory of [
              paths.canonicalEventHandoffsRoot(),
              paths.canonicalEventHandoffQuarantineRoot(),
            ])
              for (const name of await directoryNames(directory))
                if (ordered.some((id) => name.startsWith(`${encodePragmaPathSegment(id)}.`)))
                  files.push(join(directory, name));
            return await action(files);
          };
          try {
            const acquireSession = async (
              index: number,
            ): Promise<Awaited<ReturnType<typeof action>>> => {
              const id = sessions[index];
              return id === undefined
                ? await acquire(0, false)
                : await withFileLock(paths.expertSessionLock(id), () => acquireSession(index + 1), {
                    operation: "session.deletion-barrier",
                  });
            };
            return await acquireSession(0);
          } finally {
            for (const id of ordered) deleting.delete(id);
          }
        },
        { operation: "execution.deletion-batch" },
      );
    },
    async drainCanonicalEvents() {
      for (const id of scheduledDeliveries.keys()) cancelScheduledDelivery(id);
      for (const id of await pendingIds()) await deliver(id, historicalSources.has(id));
      await Promise.all(deliveries.values());
    },
    async recoverPendingCanonicalEvents(input) {
      if (recoveryOperation !== undefined) return await recoveryOperation;
      const operation = (async () => {
        const ids = await pendingIds();
        const members = new Set(ids);
        for (const id of recoveryRetries.keys()) if (!members.has(id)) recoveryRetries.delete(id);
        const start =
          recoveryCursor === undefined ? 0 : ids.findIndex((id) => id > recoveryCursor!);
        const ordered = start < 0 ? ids : [...ids.slice(start), ...ids.slice(0, start)];
        let recovered = 0;
        let failed = 0;
        const requestedLimit = input?.limit ?? 64;
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(0, Math.min(64, Math.floor(requestedLimit)))
          : 64;
        for (const id of ordered) {
          if (recovered + failed >= limit) break;
          if ((recoveryRetries.get(id)?.nextAt ?? 0) > Date.now()) continue;
          recoveryCursor = id;
          try {
            await deliver(id, historicalSources.has(id));
            recoveryRetries.delete(id);
            recovered++;
          } catch (error) {
            failed++;
            const attempts = Math.min(7, (recoveryRetries.get(id)?.attempts ?? 0) + 1);
            recoveryRetries.delete(id);
            recoveryRetries.set(id, {
              attempts,
              nextAt: Date.now() + Math.min(30_000, 500 * 2 ** (attempts - 1)),
            });
            while (recoveryRetries.size > 1024)
              recoveryRetries.delete(recoveryRetries.keys().next().value!);
            options.logger?.warn(
              "execution.canonical_recovery_failed",
              "Owner delivery retained for retry.",
              {
                executionId: id,
                error,
                errorCode: "execution_canonical_delivery_failed",
              },
            );
          }
        }
        const pending = await pendingIds();
        return {
          recovered,
          pending: pending.length,
          // Backoff suppresses attempts, not the degraded state of retained failures.
          failed: Math.max(failed, pending.filter((id) => recoveryRetries.has(id)).length),
          quarantined: await quarantinedCount(),
        };
      })();
      recoveryOperation = operation;
      try {
        return await operation;
      } finally {
        if (recoveryOperation === operation) recoveryOperation = undefined;
      }
    },
    async inspectCanonicalEventDelivery() {
      return { pending: (await pendingIds()).length, quarantined: await quarantinedCount() };
    },
    async close() {
      if (closeOperation !== undefined) return await closeOperation;
      closeRequested = true;
      const operation = (async () => {
        try {
          await Promise.allSettled([...activeCalls]);
          await store.drainCanonicalEvents();
        } finally {
          closing = true;
          await pool.close();
        }
      })();
      closeOperation = operation;
      return await operation;
    },
  };
  return store;
}
