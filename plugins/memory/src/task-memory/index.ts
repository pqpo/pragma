import type {
  ExpertAgentPluginContributions,
  ExpertAgentPluginSetupContext,
} from "@pragma/core";

import { MemorySystem, type MemorySummaryConfig, type TaskMemoryStore } from "../memory-system/index.ts";
import { createFileSystemTaskMemoryStore } from "./store.ts";
import { createTaskMemoryTools } from "./tools.ts";

export { createFileSystemTaskMemoryStore } from "./store.ts";
export { createTaskMemoryTools } from "./tools.ts";

export interface TaskMemoryStoreFactoryContext {
  readonly pluginContext: ExpertAgentPluginSetupContext;
  readonly summaryConfig?: Partial<MemorySummaryConfig> | undefined;
}

export type TaskMemoryStoreFactory = (
  context: TaskMemoryStoreFactoryContext,
) => TaskMemoryStore;

export interface TaskMemoryPluginConfig {
  readonly enabled?: boolean | undefined;
  readonly filePath?: string | undefined;
  readonly store?: TaskMemoryStore | undefined;
  readonly storeFactory?: TaskMemoryStoreFactory | undefined;
}

type TaskMemoryPluginSetupContext = ExpertAgentPluginSetupContext & {
  readonly memorySystem: MemorySystem;
};

export const taskMemoryCapabilities = [
  {
    type: "memory",
    name: "task-memory",
    description: "Registers the task memory store.",
  },
  {
    type: "tool",
    name: "task-memory-tools",
    description: "Injects task memory tools into the agent tool set.",
  },
] as const;

export function createTaskMemoryContributions(
  context: TaskMemoryPluginSetupContext,
): ExpertAgentPluginContributions {
  const config = readTaskMemoryConfig(context.config);

  if (config.enabled === false) {
    return {};
  }

  const store = resolveTaskMemoryStore(config, context);
  const registration = context.memorySystem.registerTaskStore({
    store,
  });

  if (!registration.ok && registration.error.code !== "store_already_registered") {
    throw new Error(registration.error.message);
  }

  return {
    tools: createTaskMemoryTools({
      memorySystem: context.memorySystem,
      defaultAgentId: context.agent?.id,
    }),
  };
}

function readTaskMemoryConfig(input: unknown): TaskMemoryPluginConfig {
  if (input === undefined || input === null) {
    return { enabled: true };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Task memory config must be an object when provided.");
  }

  const task = "task" in input ? (input as { task?: unknown }).task : input;

  if (task === undefined || task === null) {
    return { enabled: true };
  }

  if (typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Task memory config must be an object when provided.");
  }

  const enabled = (task as { enabled?: unknown }).enabled;
  const filePath = (task as { filePath?: unknown }).filePath;
  const store = (task as { store?: unknown }).store;
  const storeFactory = (task as { storeFactory?: unknown }).storeFactory;

  if (enabled === undefined) {
    return {
      enabled: true,
      ...(filePath === undefined ? {} : { filePath: assertOptionalString(filePath, "filePath") }),
      ...(store === undefined ? {} : { store: assertTaskMemoryStore(store) }),
      ...(storeFactory === undefined
        ? {}
        : { storeFactory: assertTaskMemoryStoreFactory(storeFactory) }),
    };
  }

  if (typeof enabled !== "boolean") {
    throw new Error("Task memory config enabled must be a boolean when provided.");
  }

  return {
    enabled,
    ...(filePath === undefined ? {} : { filePath: assertOptionalString(filePath, "filePath") }),
    ...(store === undefined ? {} : { store: assertTaskMemoryStore(store) }),
    ...(storeFactory === undefined
      ? {}
      : { storeFactory: assertTaskMemoryStoreFactory(storeFactory) }),
  };
}

function resolveTaskMemoryStore(
  config: TaskMemoryPluginConfig,
  context: TaskMemoryPluginSetupContext,
): TaskMemoryStore {
  if (config.store !== undefined) {
    return config.store;
  }

  if (config.storeFactory !== undefined) {
    return config.storeFactory({
      pluginContext: context,
      summaryConfig: readMemorySummaryConfig(context.config),
    });
  }

  return createFileSystemTaskMemoryStore({
    agentId: context.agent?.id ?? "unknown-agent",
    filePath: config.filePath,
    summaryMaxChars: readMemorySummaryConfig(context.config)?.perRecordMaxChars,
  });
}

function assertTaskMemoryStore(input: unknown): TaskMemoryStore {
  if (isTaskMemoryStore(input)) {
    return input;
  }

  throw new Error("Task memory config store must implement the TaskMemoryStore interface.");
}

function assertTaskMemoryStoreFactory(input: unknown): TaskMemoryStoreFactory {
  if (typeof input === "function") {
    return input as TaskMemoryStoreFactory;
  }

  throw new Error("Task memory config storeFactory must be a function.");
}

function assertOptionalString(input: unknown, fieldName: string): string {
  if (typeof input === "string" && input.length > 0) {
    return input;
  }

  throw new Error(`Task memory config ${fieldName} must be a non-empty string.`);
}

function readMemorySummaryConfig(input: unknown): Partial<MemorySummaryConfig> | undefined {
  if (input === undefined || input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const summary = (input as { summary?: unknown }).summary;

  if (summary === undefined || summary === null) {
    return undefined;
  }

  if (typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("Memory plugin summary config must be an object.");
  }

  return summary as Partial<MemorySummaryConfig>;
}

function isTaskMemoryStore(input: unknown): input is TaskMemoryStore {
  if (input === null || typeof input !== "object") {
    return false;
  }

  const store = input as Partial<Record<keyof TaskMemoryStore, unknown>>;

  return (
    typeof store.list === "function" &&
    typeof store.get === "function" &&
    typeof store.append === "function" &&
    typeof store.patch === "function" &&
    typeof store.archive === "function" &&
    typeof store.retrieveForRuntime === "function" &&
    typeof store.listForSummary === "function"
  );
}
