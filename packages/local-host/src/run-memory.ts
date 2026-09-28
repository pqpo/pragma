import {
  createFileCanonicalEventFeed,
  createFileExecutionStore,
  createPragmaLogger,
  PragmaPaths,
  type CanonicalEventFeed,
  type PragmaLoggerProvider,
} from "@pragma/core";
import { createLocalHostMemoryDataPlane } from "./memory-data-plane.ts";
import { createLocalHostMemoryContextService } from "./memory-context.ts";
import { createSecretStore } from "./secrets/secret-store.ts";
import { createNativeOsKeychain } from "./secrets/native-os-keychain.ts";

/** CLI process lifetime only: no daemon, settings writer, or model extraction worker. */
export function createLocalHostRunMemory(options: {
  pragmaHome: string;
  loggerProvider?: PragmaLoggerProvider;
}) {
  let feed: Promise<CanonicalEventFeed> | undefined;
  const getFeed = () => (feed ??= createFileCanonicalEventFeed(options));
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
  const executionStore = createFileExecutionStore({ ...options, canonicalEventFeed: canonical });
  const paths = new PragmaPaths(options);
  const owners = new Set<string>();
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
  return {
    executionStore,
    async bindings(input: { missionId: string; goal: string; projectId?: string }) {
      return serialize(async () => {
        owners.add(input.missionId);
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
        try {
          const { data } = await get();
          await data.registerExecutionContext(input);
          await data.setConversationState({ missionId: input.missionId, state: "running" });
        } catch {
          degraded();
        }
      });
    },
    async complete(missionId: string, waiting = false) {
      return serialize(async () => {
        try {
          if (memory === undefined) return;
          const { data, contexts } = await memory;
          await contexts.stopMission(missionId);
          await data.setConversationState({ missionId, state: waiting ? "active" : "completed" });
          await data.flushDelivery();
        } catch {
          degraded();
        } finally {
          owners.delete(missionId);
        }
      });
    },
    async close() {
      return serialize(async () => {
        if (owners.size > 0) return;
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
          try {
            await canonical.close();
          } catch {
            degraded();
          }
        }
      });
    },
  };
}
