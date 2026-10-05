import {
  createFileCanonicalEventFeed,
  createPragmaLogger,
  PragmaPaths,
  type CanonicalEventFeed,
  type PragmaLoggerProvider,
} from "@pragma/core";
import { createLocalHostMissionMemoryLifecycle } from "./mission-memory-lifecycle.ts";
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
  onPause?: () => Promise<void>;
}) {
  let feed: Promise<CanonicalEventFeed> | undefined;
  const getFeed = () => (feed ??= createFileCanonicalEventFeed({ pragmaHome: options.pragmaHome }));
  const canonical: CanonicalEventFeed = {
    append: async (events) => await (await getFeed()).append(events),
    read: async (input) => await (await getFeed()).read(input),
    inspect: async () => await (await getFeed()).inspect(),
    maintain: async (input) => await (await getFeed()).maintain(input),
    forgetCorrelation: async (id) => await (await getFeed()).forgetCorrelation(id),
    subscribeChanges: (listener) => {
      let cancelled = false;
      let unsubscribe: (() => void) | undefined;
      void getFeed().then(
        (source) => {
          if (!cancelled) unsubscribe = source.subscribeChanges?.(listener);
        },
        (error: unknown) => {
          logger.warn("canonical.subscription_degraded", "Canonical delivery wake needs recovery", {
            moduleId: "pragma.mission-delivery",
            errorCode: "MISSION_DELIVERY_RECEIVE_FAILED",
            error,
          });
        },
      );
      return () => {
        cancelled = true;
        unsubscribe?.();
      };
    },
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
    }
  };
  let deliveryPause: Promise<void> | undefined;
  let resourcesClosed = false;
  let resourceCloseFailure: unknown;
  const lifecycle = createLocalHostMissionMemoryLifecycle({
    onError: degraded,
    ports: {
      bindings: async (input) => {
        const { data, contexts } = await get();
        if ((await data.policies.getGlobal()).policy.enabled !== "enabled") return [];
        return [{ namespace: "memory", store: contexts.createContextStore(input) }];
      },
      register: async (input) => await (await get()).data.registerExecutionContext(input),
      setConversationState: async (input) => await (await get()).data.setConversationState(input),
      stopMission: async (missionId) => {
        if (memory !== undefined) await (await memory).contexts.stopMission(missionId);
      },
      flushDelivery: async () => {
        if (memory !== undefined) await (await memory).data.flushDelivery();
      },
      pause: async () => {
        deliveryPause = options.onPause?.();
        // Receipt materialization may itself complete Memory; do not wait under its state lock.
        void deliveryPause?.catch(degraded);
        await stopIdleMemory();
        await executionStore.drainCanonicalEvents();
      },
      beforeClose: options.beforeFeedClose,
      close: async () => {
        await stopIdleMemory();
        const errors: unknown[] = [];
        try {
          await executionStore.close();
        } catch (error) {
          degraded();
          errors.push(error);
        }
        try {
          await canonical.close();
        } catch (error) {
          degraded();
          errors.push(error);
        }
        if (errors.length > 0) {
          resourceCloseFailure = new AggregateError(
            errors,
            "Mission Memory resource close failed.",
          );
          throw resourceCloseFailure;
        }
        resourceCloseFailure = undefined;
        resourcesClosed = true;
      },
    },
  });
  return {
    canonical,
    hasCanonicalSource: () => feed !== undefined,
    executionStore,
    ...lifecycle,
    dispose: async () => {
      if (resourcesClosed) return;
      const deadline = Date.now() + 5000;
      do {
        await lifecycle.close();
        if (resourceCloseFailure !== undefined) throw resourceCloseFailure;
        if (resourcesClosed) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      throw new Error("MISSION_MEMORY_SHUTDOWN_PENDING");
    },
    pause: async () => {
      await lifecycle.pause();
      const pending = deliveryPause;
      await pending;
      if (deliveryPause === pending) deliveryPause = undefined;
    },
  };
}
