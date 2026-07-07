import type {
  ExpertAgentPluginContributions,
  ExpertAgentPluginSetupContext,
} from "@pragma/core";

import { MemorySystem, type FactMemoryStore } from "../memory-system/index.ts";
import { createFileSystemFactMemoryStore } from "./store.ts";
export { createFileSystemFactMemoryStore } from "./store.ts";

export interface FactMemoryStoreFactoryContext {
  readonly pluginContext: ExpertAgentPluginSetupContext;
}

export type FactMemoryStoreFactory = (
  context: FactMemoryStoreFactoryContext,
) => FactMemoryStore;

export interface FactMemoryPluginConfig {
  readonly enabled?: boolean | undefined;
  readonly filePath?: string | undefined;
  readonly store?: FactMemoryStore | undefined;
  readonly storeFactory?: FactMemoryStoreFactory | undefined;
}

type FactMemoryPluginSetupContext = ExpertAgentPluginSetupContext & {
  readonly memorySystem: MemorySystem;
};

export const factMemoryCapabilities = [
  {
    type: "memory",
    name: "fact-memory",
    description: "Registers the fact memory store.",
  },
] as const;

export function createFactMemoryContributions(
  context: FactMemoryPluginSetupContext,
): ExpertAgentPluginContributions {
  const config = readFactMemoryConfig(context.config);

  if (config.enabled === false) {
    return {};
  }

  const store = resolveFactMemoryStore(config, context);
  const registration = context.memorySystem.registerFactStore({
    store,
  });

  if (!registration.ok && registration.error.code !== "store_already_registered") {
    throw new Error(registration.error.message);
  }

  return {};
}

function readFactMemoryConfig(input: unknown): FactMemoryPluginConfig {
  if (input === undefined || input === null) {
    return { enabled: true };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Fact memory config must be an object when provided.");
  }

  const fact = "fact" in input ? (input as { fact?: unknown }).fact : input;

  if (fact === undefined || fact === null) {
    return { enabled: true };
  }

  if (typeof fact !== "object" || Array.isArray(fact)) {
    throw new Error("Fact memory config must be an object when provided.");
  }

  const enabled = (fact as { enabled?: unknown }).enabled;
  const filePath = (fact as { filePath?: unknown }).filePath;
  const store = (fact as { store?: unknown }).store;
  const storeFactory = (fact as { storeFactory?: unknown }).storeFactory;

  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Fact memory config enabled must be a boolean when provided.");
  }

  return {
    enabled: enabled ?? true,
    ...(filePath === undefined ? {} : { filePath: assertOptionalString(filePath, "filePath") }),
    ...(store === undefined ? {} : { store: assertFactMemoryStore(store) }),
    ...(storeFactory === undefined ? {} : { storeFactory: assertFactMemoryStoreFactory(storeFactory) }),
  };
}

function resolveFactMemoryStore(
  config: FactMemoryPluginConfig,
  context: FactMemoryPluginSetupContext,
): FactMemoryStore {
  if (config.store !== undefined) {
    return config.store;
  }

  if (config.storeFactory !== undefined) {
    return config.storeFactory({
      pluginContext: context,
    });
  }

  return createFileSystemFactMemoryStore({
    agentId: context.agent?.id ?? "unknown-agent",
    filePath: config.filePath,
  });
}

function assertFactMemoryStore(input: unknown): FactMemoryStore {
  if (isFactMemoryStore(input)) {
    return input;
  }

  throw new Error("Fact memory config store must implement the FactMemoryStore interface.");
}

function assertFactMemoryStoreFactory(input: unknown): FactMemoryStoreFactory {
  if (typeof input === "function") {
    return input as FactMemoryStoreFactory;
  }

  throw new Error("Fact memory config storeFactory must be a function.");
}

function assertOptionalString(input: unknown, fieldName: string): string {
  if (typeof input === "string" && input.length > 0) {
    return input;
  }

  throw new Error(`Fact memory config ${fieldName} must be a non-empty string.`);
}

function isFactMemoryStore(input: unknown): input is FactMemoryStore {
  if (input === null || typeof input !== "object") {
    return false;
  }

  const store = input as Partial<Record<keyof FactMemoryStore, unknown>>;

  return (
    typeof store.list === "function" &&
    typeof store.get === "function" &&
    typeof store.upsert === "function" &&
    typeof store.search === "function" &&
    typeof store.retrieveForRuntime === "function"
  );
}
