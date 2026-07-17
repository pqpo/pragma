import type { ExpertAgentPluginContributions, ExpertAgentPluginSetupContext } from "@pragma/core";

import { MemorySystem, type ExperienceMemoryStore } from "../memory-system/index.ts";
import { createFileSystemExperienceMemoryStore } from "./store.ts";

export { createFileSystemExperienceMemoryStore } from "./store.ts";

export interface ExperienceMemoryStoreFactoryContext {
  readonly pluginContext: ExpertAgentPluginSetupContext;
}

export type ExperienceMemoryStoreFactory = (
  context: ExperienceMemoryStoreFactoryContext,
) => ExperienceMemoryStore;

export interface ExperienceMemoryPluginConfig {
  readonly enabled?: boolean | undefined;
  readonly filePath?: string | undefined;
}

export interface ExperienceMemoryPluginHostBindings {
  readonly store?: ExperienceMemoryStore | undefined;
  readonly storeFactory?: ExperienceMemoryStoreFactory | undefined;
}

type ExperienceMemoryPluginSetupContext = ExpertAgentPluginSetupContext & {
  readonly memorySystem: MemorySystem;
};

export const experienceMemoryCapabilities = [
  {
    type: "memory",
    name: "experience-memory",
    description: "Registers the experience memory store.",
  },
] as const;

export function createExperienceMemoryContributions(
  context: ExperienceMemoryPluginSetupContext,
): ExpertAgentPluginContributions {
  const config = {
    ...readExperienceMemoryConfig(context.userConfig),
    ...readExperienceMemoryHostBindings(context.hostBindings),
  };

  if (config.enabled === false) {
    return {};
  }

  const store = resolveExperienceMemoryStore(config, context);
  const registration = context.memorySystem.registerExperienceStore({
    store,
  });

  if (!registration.ok && registration.error.code !== "store_already_registered") {
    throw new Error(registration.error.message);
  }

  return {};
}

function readExperienceMemoryConfig(input: unknown): ExperienceMemoryPluginConfig {
  if (input === undefined || input === null) {
    return { enabled: true };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Experience memory config must be an object when provided.");
  }

  const experience = "experience" in input ? (input as { experience?: unknown }).experience : input;

  if (experience === undefined || experience === null) {
    return { enabled: true };
  }

  if (typeof experience !== "object" || Array.isArray(experience)) {
    throw new Error("Experience memory config must be an object when provided.");
  }

  const enabled = (experience as { enabled?: unknown }).enabled;
  const filePath = (experience as { filePath?: unknown }).filePath;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Experience memory config enabled must be a boolean when provided.");
  }

  return {
    enabled: enabled ?? true,
    ...(filePath === undefined ? {} : { filePath: assertOptionalString(filePath, "filePath") }),
  };
}

function resolveExperienceMemoryStore(
  config: ExperienceMemoryPluginConfig & ExperienceMemoryPluginHostBindings,
  context: ExperienceMemoryPluginSetupContext,
): ExperienceMemoryStore {
  if (config.store !== undefined) {
    return config.store;
  }

  if (config.storeFactory !== undefined) {
    return config.storeFactory({
      pluginContext: context,
    });
  }

  return createFileSystemExperienceMemoryStore({
    agentId: context.agent?.id ?? "unknown-agent",
    filePath: config.filePath,
  });
}

function assertExperienceMemoryStore(input: unknown): ExperienceMemoryStore {
  if (isExperienceMemoryStore(input)) {
    return input;
  }

  throw new Error(
    "Experience memory config store must implement the ExperienceMemoryStore interface.",
  );
}

function assertExperienceMemoryStoreFactory(input: unknown): ExperienceMemoryStoreFactory {
  if (typeof input === "function") {
    return input as ExperienceMemoryStoreFactory;
  }

  throw new Error("Experience memory config storeFactory must be a function.");
}

function readExperienceMemoryHostBindings(
  input: Readonly<Record<string, unknown>>,
): ExperienceMemoryPluginHostBindings {
  const experience = input["experience"];
  if (experience === undefined) return {};
  if (experience === null || typeof experience !== "object" || Array.isArray(experience)) {
    throw new Error("Experience memory hostBindings.experience must be an object.");
  }
  const value = experience as Record<string, unknown>;
  return {
    ...(value["store"] === undefined ? {} : { store: assertExperienceMemoryStore(value["store"]) }),
    ...(value["storeFactory"] === undefined
      ? {}
      : { storeFactory: assertExperienceMemoryStoreFactory(value["storeFactory"]) }),
  };
}

function assertOptionalString(input: unknown, fieldName: string): string {
  if (typeof input === "string" && input.length > 0) {
    return input;
  }

  throw new Error(`Experience memory config ${fieldName} must be a non-empty string.`);
}

function isExperienceMemoryStore(input: unknown): input is ExperienceMemoryStore {
  if (input === null || typeof input !== "object") {
    return false;
  }

  const store = input as Partial<Record<keyof ExperienceMemoryStore, unknown>>;

  return (
    typeof store.list === "function" &&
    typeof store.get === "function" &&
    typeof store.upsert === "function" &&
    typeof store.search === "function" &&
    typeof store.retrieveForRuntime === "function"
  );
}
