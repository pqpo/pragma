import {
  createFileCanonicalEventFeed,
  createPragmaLogger,
  PragmaPaths,
  type CanonicalEventFeed,
  type PragmaLoggerProvider,
} from "@pragma/core";
import { createSqliteExecutionStore } from "./execution/sqlite-execution-store.ts";
import { createLocalHostMemoryContextService } from "./memory-context.ts";
import { createLocalHostMemoryDataPlane } from "./memory-data-plane.ts";
import { createNativeOsKeychain } from "./secrets/native-os-keychain.ts";
import { createSecretStore } from "./secrets/secret-store.ts";

/** CLI process lifetime only: no daemon, settings writer, or model extraction worker. */
export function createLocalHostRunMemory(options: {
  pragmaHome: string;
  loggerProvider?: PragmaLoggerProvider;
  beforeFeedClose?: () => Promise<void>;
}) {
  let feed: Promise<CanonicalEventFeed> | undefined;
  const getFeed = () => (feed ??= createFileCanonicalEventFeed({ pragmaHome: options.pragmaHome }));
  const canonical: CanonicalEventFeed = {
    append: async (events) => await (await getFeed()).append(events),
    read: async (input) => await (await getFeed()).read(input),
    inspect: async () => await (await getFeed()).inspect(),
    maintain: async (input) => await (await getFeed()).maintain(input),
    forgetCorrelation: async (id) => await (await getFeed()).forgetCorrelation(id),
    close: async () => {
      if (feed !== undefined) {
        await (await feed).close();
        feed = undefined;
      }
    },
  };
  const logger = createPragmaLogger(options.loggerProvider, { component: "local-host.memory" });
  const executionStore = createSqliteExecutionStore({ ...options, canonicalEventFeed: canonical });
  const paths = new PragmaPaths(options);
  type MemoryOwner = {
    bindingId: string;
    executionId?: string;
    terminal?: { executionId: string; waiting: boolean };
  };
  const owners = new Map<string, MemoryOwner>();
  const intents = new Map<
    string,
    {
      owner: MemoryOwner;
      previous: MemoryOwner | undefined;
      deferred?: { executionId: string; waiting: boolean };
    }
  >();
  const replayCompletion = async (
    missionId: string,
    executionId: string,
    waiting: boolean,
  ): Promise<void> => await api.complete(missionId, executionId, waiting);
  const bindings = new Map<string, string>();
  const pendingCompletions = new Set<Promise<void>>();
  let memory:
    | Promise<{
        data: Awaited<ReturnType<typeof createLocalHostMemoryDataPlane>>;
        contexts: ReturnType<typeof createLocalHostMemoryContextService>;
      }>
    | undefined;
  const get = () =>
    (memory ??= (async () => {
      const data = await createLocalHostMemoryDataPlane({
        ...options,
        logger,
        executionStore,
        canonical,
      });
      const secrets = createSecretStore({
        root: paths.secretStoreRoot(),
        dataRoot: paths.dataRoot(),
        keychain: createNativeOsKeychain(),
      });
      const contexts = createLocalHostMemoryContextService({
        ...options,
        data,
        secrets,
        onDiagnostic: (code) => {
          if (code !== undefined)
            logger.warn("memory.attention_degraded", "Memory Attention is degraded.", {
              subsystem: "memory.attention",
              code,
            });
        },
      });
      return { data, contexts };
    })());
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const degraded = () =>
    logger.warn("memory.delivery_degraded", "Memory is unavailable; execution can continue.", {
      subsystem: "memory",
      code: "memory_delivery_unavailable",
    });
  const stopIdleMemory = async (): Promise<void> => {
    try {
      if (memory !== undefined) {
        const { data, contexts } = await memory;
        try {
          await contexts.stop();
        } finally {
          try {
            await data.scheduler.stop();
          } finally {
            data.episodic.close();
            data.semantic.close();
            data.knowledge.close();
            data.skill.close();
          }
        }
      }
    } catch {
      degraded();
    } finally {
      memory = undefined;
      bindings.clear();
    }
  };
  const api = {
    canonical,
    executionStore,
    async bindings(input: {
      missionId: string;
      goal: string;
      projectId?: string;
      bindingId?: string;
    }) {
      return serialize(async () => {
        const bindingId = input.bindingId ?? input.missionId;
        bindings.set(input.missionId, bindingId);
        if (owners.get(input.missionId)?.bindingId !== bindingId)
          owners.set(input.missionId, { bindingId, executionId: bindingId });
        try {
          const { data, contexts } = await get();
          if ((await data.policies.getGlobal()).policy.enabled !== "enabled") return [];
          return [{ namespace: "memory", store: contexts.createContextStore(input) }];
        } catch {
          degraded();
          return [];
        }
      });
    },
    async register(input: { missionId: string; executionId: string; projectId?: string }) {
      return serialize(async () => {
        const owner = owners.get(input.missionId) ?? { bindingId: input.missionId };
        owners.set(input.missionId, {
          bindingId: owner.bindingId,
          executionId: input.executionId,
        });
        intents.delete(input.missionId);
        try {
          const { data } = await get();
          await data.registerExecutionContext(input);
          await data.setConversationState({ missionId: input.missionId, state: "running" });
        } catch {
          degraded();
        }
      });
    },
    async resume(missionId: string, executionId: string, admitting = false) {
      return serialize(async () => {
        const previous = owners.get(missionId);
        const owner = previous ?? { bindingId: bindings.get(missionId) ?? missionId };
        const intent = { bindingId: owner.bindingId, executionId };
        owners.set(missionId, intent);
        const pending = { owner: intent, previous, deferred: previous?.terminal } as {
          owner: typeof intent;
          previous: typeof previous;
          deferred?: { executionId: string; waiting: boolean };
        };
        if (admitting) intents.set(missionId, pending);
        else intents.delete(missionId);
        try {
          const { data } = await get();
          if (!admitting) await data.setConversationState({ missionId, state: "running" });
        } catch {
          degraded();
        }
        return async () => {
          const deferred = await serialize(async () => {
            if (owners.get(missionId) !== intent) return undefined;
            if (previous === undefined) owners.delete(missionId);
            else owners.set(missionId, previous);
            intents.delete(missionId);
            return pending.deferred;
          });
          if (deferred !== undefined)
            void replayCompletion(missionId, deferred.executionId, deferred.waiting).catch(
              degraded,
            );
        };
      });
    },
    async beginPrompt(missionId: string, requestId: string): Promise<() => Promise<void>> {
      return await api.resume(missionId, requestId, true);
    },
    async complete(missionId: string, executionId: string, waiting = false) {
      const capturedOwner = owners.get(missionId);
      // Preserve the terminal fact on this generation before native teardown.
      // A rejected prompt may restore it while that teardown is still pending.
      if (capturedOwner?.executionId === executionId)
        capturedOwner.terminal = { executionId, waiting };
      const completion = (async () => {
        try {
          const closing = await serialize(async () => {
            const intent = intents.get(missionId);
            if (
              intent !== undefined &&
              owners.get(missionId) === intent.owner &&
              intent.previous?.executionId === executionId
            ) {
              intent.deferred = { executionId, waiting };
              return undefined;
            }
            if (
              owners.get(missionId) !== capturedOwner ||
              capturedOwner?.executionId !== executionId ||
              memory === undefined
            )
              return undefined;
            const { data, contexts } = await memory;
            if (owners.get(missionId) !== capturedOwner) return undefined;
            // stopMission detaches its current generation synchronously. Its
            // native cancellation may finish after the next round registers.
            const stopped = contexts.stopMission(missionId);
            void stopped.catch(() => undefined);
            return { data, stopped };
          });
          if (closing === undefined) return;
          await closing.stopped;
          await serialize(async () => {
            if (owners.get(missionId) !== capturedOwner) return;
            await closing.data.setConversationState({
              missionId,
              state: waiting ? "active" : "completed",
            });
            owners.delete(missionId);
            intents.delete(missionId);
          });
          await closing.data.flushDelivery();
        } catch {
          await serialize(async () => {
            if (owners.get(missionId) === capturedOwner) owners.delete(missionId);
          });
          degraded();
        }
      })();
      pendingCompletions.add(completion);
      try {
        await completion;
      } finally {
        pendingCompletions.delete(completion);
      }
    },
    async pause() {
      return serialize(async () => {
        if (owners.size > 0 || pendingCompletions.size > 0) return;
        await stopIdleMemory();
        await executionStore.drainCanonicalEvents();
      });
    },
    async close() {
      return serialize(async () => {
        if (owners.size > 0 || pendingCompletions.size > 0) return;
        await stopIdleMemory();
        try {
          await executionStore.close();
        } catch {
          degraded();
        }
        try {
          await options.beforeFeedClose?.();
        } catch {
          degraded();
        }
        try {
          await canonical.close();
        } catch {
          degraded();
        }
      });
    },
  };
  return api;
}
