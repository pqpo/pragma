import type { ExpertAgentPluginContributions, ExpertAgentPluginSetupContext } from "@pragma/core";

import {
  MemorySystem,
  type MemorySummaryConfig,
  type TaskMemoryStore,
} from "../memory-system/index.ts";
import { createFileSystemTaskMemoryStore } from "./store.ts";
import { createTaskMemoryTools } from "./tools.ts";

export { createFileSystemTaskMemoryStore } from "./store.ts";
export { createTaskMemoryTools } from "./tools.ts";

export interface TaskMemoryStoreFactoryContext {
  readonly pluginContext: ExpertAgentPluginSetupContext;
  readonly summaryConfig?: Partial<MemorySummaryConfig> | undefined;
}

export type TaskMemoryStoreFactory = (context: TaskMemoryStoreFactoryContext) => TaskMemoryStore;

export interface TaskMemoryPluginConfig {
  readonly enabled?: boolean | undefined;
  readonly rootDir?: string | undefined;
  readonly filePath?: string | undefined;
}

export interface TaskMemoryPluginHostBindings {
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
  const config = {
    ...readTaskMemoryConfig(context.userConfig),
    ...readTaskMemoryHostBindings(context.hostBindings),
  };

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
    }).filter((tool) => tool.name === "append_task_memory" || tool.name === "patch_task_memory"),
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
  const rootDir = (task as { rootDir?: unknown }).rootDir;
  const filePath = (task as { filePath?: unknown }).filePath;
  if (enabled === undefined) {
    return {
      enabled: true,
      ...(rootDir === undefined ? {} : { rootDir: assertOptionalString(rootDir, "rootDir") }),
      ...(filePath === undefined ? {} : { filePath: assertOptionalString(filePath, "filePath") }),
    };
  }

  if (typeof enabled !== "boolean") {
    throw new Error("Task memory config enabled must be a boolean when provided.");
  }

  return {
    enabled,
    ...(rootDir === undefined ? {} : { rootDir: assertOptionalString(rootDir, "rootDir") }),
    ...(filePath === undefined ? {} : { filePath: assertOptionalString(filePath, "filePath") }),
  };
}

function resolveTaskMemoryStore(
  config: TaskMemoryPluginConfig & TaskMemoryPluginHostBindings,
  context: TaskMemoryPluginSetupContext,
): TaskMemoryStore {
  if (config.store !== undefined) {
    return config.store;
  }

  if (config.storeFactory !== undefined) {
    return config.storeFactory({
      pluginContext: context,
      summaryConfig: readMemorySummaryConfig(context.userConfig),
    });
  }

  return createFileSystemTaskMemoryStore({
    agentId: context.agent?.id ?? "unknown-agent",
    rootDir: config.rootDir,
    filePath: config.filePath,
    summaryMaxChars: readMemorySummaryConfig(context.userConfig)?.perRecordMaxChars,
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

function readTaskMemoryHostBindings(
  input: Readonly<Record<string, unknown>>,
): TaskMemoryPluginHostBindings {
  const task = input["task"];
  if (task === undefined) return {};
  if (task === null || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Task memory hostBindings.task must be an object.");
  }
  const value = task as Record<string, unknown>;
  return {
    ...(value["store"] === undefined ? {} : { store: assertTaskMemoryStore(value["store"]) }),
    ...(value["storeFactory"] === undefined
      ? {}
      : { storeFactory: assertTaskMemoryStoreFactory(value["storeFactory"]) }),
  };
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
