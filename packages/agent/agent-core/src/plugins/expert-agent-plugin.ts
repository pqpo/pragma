import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type {
  ExpertAgent,
  ExpertAgentModelApi,
  IExpertAgentMcpConfig,
  IExpertAgentModelsConfig,
  IExpertAgentSkillsConfig,
  IExpertAgentModelProviderConfig,
} from "../agent/expert-agent.ts";
import type {
  ExpertAgentContextItemSeed,
  ExpertAgentContextStore,
} from "../context-system/context-system.ts";
import { HOST_CONTEXT_NAMESPACE } from "../context-system/context-system.ts";
import { createInMemoryContextStore } from "../context-system/in-memory-context-store.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import type {
  RuntimeSubmitRequest,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeSessionRef,
} from "../runtime/runtime-adapter.ts";
import type { SubAgentRegistry } from "../subagents/sub-agent.ts";
import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "../tools/managed-tool.ts";

type MaybePromise<TValue> = TValue | Promise<TValue>;
type DeepReadonly<TValue> = TValue extends (...args: never[]) => unknown
  ? TValue
  : TValue extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : TValue extends object
      ? { readonly [TKey in keyof TValue]: DeepReadonly<TValue[TKey]> }
      : TValue;

const ExpertAgentPluginCapabilitySchema = z
  .object({
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
  })
  .passthrough();

const ExpertAgentPluginRequiredEnvironmentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    required: z.boolean().default(true),
    secret: z.boolean().default(false),
  })
  .passthrough();

const ExpertAgentPluginManifestSchema = z
  .object({
    schemaVersion: z.literal("expertmesh.plugin/v1"),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    runtime: z
      .object({
        type: z.string().min(1),
        entry: z.string().min(1),
      })
      .passthrough(),
    capabilities: z.array(ExpertAgentPluginCapabilitySchema).default([]),
    requires_env: z.array(ExpertAgentPluginRequiredEnvironmentSchema).default([]),
  })
  .passthrough();

export type ExpertAgentPluginManifest = DeepReadonly<
  z.infer<typeof ExpertAgentPluginManifestSchema> & Record<string, unknown>
>;

export type ExpertAgentPluginMetadata = Pick<
  ExpertAgentPluginManifest,
  "id" | "name" | "description" | "version" | "tags"
>;

export type ExpertAgentPluginContextContribution =
  | ExpertAgentContextStore
  | readonly ExpertAgentContextItemSeed[];

export interface ExpertAgentPluginSessionCreateContext {
  readonly agent: ExpertAgent;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly systemSessionId: string;
  readonly runtimeSession?: RuntimeSessionRef | undefined;
}

export interface ExpertAgentPluginSessionContext {
  readonly agent: ExpertAgent;
  readonly session: RuntimeSessionInfo;
}

export interface ExpertAgentPluginTaskSubmitContext<TOutput = unknown> {
  readonly agent: ExpertAgent;
  readonly session: RuntimeSessionInfo;
  readonly runId: string;
  readonly submission: RuntimeSubmitRequest<TOutput>;
}

export interface ExpertAgentPluginTaskSubmittedContext<
  TOutput = unknown,
> extends ExpertAgentPluginTaskSubmitContext<TOutput> {
  readonly result?: RuntimeRunResult<TOutput> | undefined;
  readonly error?: unknown;
}

export interface ExpertAgentPluginToolCallContext {
  readonly agent: ExpertAgent;
  readonly toolName: string;
  readonly toolCallId?: string | undefined;
  readonly args: unknown;
  readonly runId?: string | undefined;
}

export interface ExpertAgentPluginToolCalledContext extends ExpertAgentPluginToolCallContext {
  readonly durationMs: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface ExpertAgentPluginSetupContext {
  readonly host: ExpertAgentPluginContributions;
  readonly hostContexts?: ExpertAgentContextStore | undefined;
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ExpertAgentPluginHooks {
  readonly beforeSessionCreate?:
    | ((context: ExpertAgentPluginSessionCreateContext) => MaybePromise<void>)
    | undefined;
  readonly afterSessionCreate?:
    | ((context: ExpertAgentPluginSessionContext) => MaybePromise<void>)
    | undefined;
  readonly beforeTaskSubmit?:
    | (<TOutput = unknown>(
        context: ExpertAgentPluginTaskSubmitContext<TOutput>,
      ) => MaybePromise<void>)
    | undefined;
  readonly afterTaskSubmit?:
    | (<TOutput = unknown>(
        context: ExpertAgentPluginTaskSubmittedContext<TOutput>,
      ) => MaybePromise<void>)
    | undefined;
  readonly beforeSessionDestroy?:
    | ((context: ExpertAgentPluginSessionContext) => MaybePromise<void>)
    | undefined;
  readonly afterSessionDestroy?:
    | ((context: ExpertAgentPluginSessionContext) => MaybePromise<void>)
    | undefined;
  readonly beforeToolCall?:
    | ((context: ExpertAgentPluginToolCallContext) => MaybePromise<void>)
    | undefined;
  readonly afterToolCall?:
    | ((context: ExpertAgentPluginToolCalledContext) => MaybePromise<void>)
    | undefined;
}

export interface ExpertAgentPluginContributions {
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly models?: IExpertAgentModelsConfig | undefined;
  readonly context?: ExpertAgentPluginContextContribution | undefined;
  readonly subAgents?: SubAgentRegistry | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
}

export interface ExpertAgentPluginEntry extends ExpertAgentPluginMetadata {
  readonly manifest: ExpertAgentPluginManifest;
  readonly setup: (context: ExpertAgentPluginSetupContext) => ExpertAgentPluginContributions;
}

export interface DefineExpertAgentPluginEntryOptions {
  readonly setup: (context: ExpertAgentPluginSetupContext) => ExpertAgentPluginContributions;
}

export interface ResolvedExpertAgentPluginContributions {
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly models?: IExpertAgentModelsConfig | undefined;
  readonly context?: ReadonlyMap<string, ExpertAgentContextStore> | undefined;
  readonly subAgents?: SubAgentRegistry | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
}

export interface ResolveExpertAgentPluginsOptions {
  readonly host?: ExpertAgentPluginContributions | undefined;
  readonly pluginEntries?: readonly ExpertAgentPluginEntry[] | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export function definePluginEntry(
  options: DefineExpertAgentPluginEntryOptions,
): ExpertAgentPluginEntry {
  const manifest = readExpertAgentPluginManifestFromCaller();

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.tags === undefined ? {} : { tags: manifest.tags }),
    manifest,
    setup: (context) => options.setup(context),
  };
}

export function readExpertAgentPluginManifest(
  manifestPath: string | URL,
): ExpertAgentPluginManifest {
  const path =
    manifestPath instanceof URL
      ? fileURLToPath(manifestPath)
      : isAbsolute(manifestPath)
        ? manifestPath
        : resolve(manifestPath);

  const manifest = JSON.parse(readFileSync(path, "utf8")) as unknown;

  return deepFreeze(ExpertAgentPluginManifestSchema.parse(manifest));
}

export function resolveExpertAgentPlugins(
  options: ResolveExpertAgentPluginsOptions,
): ResolvedExpertAgentPluginContributions {
  assertUniquePluginIds(options.pluginEntries ?? []);
  const host = options.host ?? {};
  const context: ExpertAgentPluginSetupContext = {
    host,
    hostContexts: host.context === undefined ? undefined : toContextStore(host.context),
    workspaceRoot: options.workspaceRoot ?? "",
    env: options.env ?? process.env,
  };
  const pluginEntries = (options.pluginEntries ?? []).map((plugin) => ({
    plugin,
    contributions: plugin.setup(context),
  }));
  const contributions = [
    options.host,
    ...pluginEntries.map((plugin) => plugin.contributions),
  ].filter(
    (contribution): contribution is ExpertAgentPluginContributions => contribution !== undefined,
  );

  return {
    mcp: mergeMcpConfigs(contributions.map((contribution) => contribution.mcp)),
    skills: mergeSkillsConfigs(contributions.map((contribution) => contribution.skills)),
    models: mergeModelsConfigs(contributions.map((contribution) => contribution.models)),
    context: mergeContextContributions(options.host?.context, pluginEntries),
    subAgents: mergeSubAgentRegistries(contributions.map((contribution) => contribution.subAgents)),
    tools: mergeManagedTools(contributions.map((contribution) => contribution.tools)),
    hooks: mergePluginHooks(contributions.map((contribution) => contribution.hooks)),
  };
}

export async function dispatchExpertAgentHook<TName extends keyof ExpertAgentPluginHooks>(
  hooks: ExpertAgentPluginHooks | undefined,
  name: TName,
  context: Parameters<NonNullable<ExpertAgentPluginHooks[TName]>>[0],
): Promise<void> {
  const hook = hooks?.[name];

  if (hook === undefined) {
    return;
  }

  await (hook as (value: typeof context) => MaybePromise<void>)(context);
}

function mergeMcpConfigs(
  configs: readonly (IExpertAgentMcpConfig | undefined)[],
): IExpertAgentMcpConfig | undefined {
  const mcpServers = Object.assign({}, ...configs.map((config) => config?.mcpServers ?? {})) as
    | IExpertAgentMcpConfig["mcpServers"]
    | undefined;

  if (mcpServers === undefined || Object.keys(mcpServers).length === 0) {
    return undefined;
  }

  return { mcpServers };
}

function mergeSkillsConfigs(
  configs: readonly (IExpertAgentSkillsConfig | undefined)[],
): IExpertAgentSkillsConfig | undefined {
  const skills = dedupeBy(
    configs.flatMap((config) => config?.skills ?? []),
    (skill) => `${skill.type}:${skill.name}:${skill.path ?? ""}:${skill.baseDir ?? ""}`,
  );

  if (skills.length === 0) {
    return undefined;
  }

  return { skills };
}

function mergeModelsConfigs(
  configs: readonly (IExpertAgentModelsConfig | undefined)[],
): IExpertAgentModelsConfig | undefined {
  const providers = mergeModelProviders(configs.flatMap((config) => config?.providers ?? []));
  const defaultModelName = configs.findLast(
    (config) => config?.defaultModelName !== undefined,
  )?.defaultModelName;

  if (providers.length === 0 && defaultModelName === undefined) {
    return undefined;
  }

  return {
    ...(defaultModelName === undefined ? {} : { defaultModelName }),
    providers,
  };
}

function mergeContextContributions(
  hostContexts: ExpertAgentPluginContextContribution | undefined,
  pluginEntries: readonly {
    readonly plugin: ExpertAgentPluginEntry;
    readonly contributions: ExpertAgentPluginContributions;
  }[],
): ReadonlyMap<string, ExpertAgentContextStore> | undefined {
  const stores = new Map<string, ExpertAgentContextStore>();

  if (hostContexts !== undefined) {
    stores.set(HOST_CONTEXT_NAMESPACE, toContextStore(hostContexts));
  }

  for (const { plugin, contributions } of pluginEntries) {
    if (contributions.context === undefined) {
      continue;
    }

    stores.set(plugin.id, toContextStore(contributions.context));
  }

  if (stores.size === 0) {
    return undefined;
  }

  return stores;
}

function mergeSubAgentRegistries(
  registries: readonly (SubAgentRegistry | undefined)[],
): SubAgentRegistry | undefined {
  const agents = dedupeBy(
    registries.flatMap((registry) => registry?.agents ?? []),
    (subAgent) => subAgent.agentType,
  );

  if (agents.length === 0) {
    return undefined;
  }

  return { agents };
}

function mergeManagedTools(
  toolGroups: readonly (
    | readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[]
    | undefined
  )[],
): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined {
  const tools = dedupeBy(
    toolGroups.flatMap((group) => group ?? []),
    (tool) => tool.name,
  );

  return tools.length === 0 ? undefined : tools;
}

function mergePluginHooks(
  hookGroups: readonly (ExpertAgentPluginHooks | undefined)[],
): ExpertAgentPluginHooks | undefined {
  const hooks = hookGroups.filter(
    (hookGroup): hookGroup is ExpertAgentPluginHooks => hookGroup !== undefined,
  );

  if (hooks.length === 0) {
    return undefined;
  }

  return {
    beforeSessionCreate: async (context) => {
      await callHooks(hooks, "beforeSessionCreate", context);
    },
    afterSessionCreate: async (context) => {
      await callHooks(hooks, "afterSessionCreate", context);
    },
    beforeTaskSubmit: async (context) => {
      await callHooks(hooks, "beforeTaskSubmit", context);
    },
    afterTaskSubmit: async (context) => {
      await callHooks(hooks, "afterTaskSubmit", context);
    },
    beforeSessionDestroy: async (context) => {
      await callHooks(hooks, "beforeSessionDestroy", context);
    },
    afterSessionDestroy: async (context) => {
      await callHooks(hooks, "afterSessionDestroy", context);
    },
    beforeToolCall: async (context) => {
      await callHooks(hooks, "beforeToolCall", context);
    },
    afterToolCall: async (context) => {
      await callHooks(hooks, "afterToolCall", context);
    },
  };
}

function toContextStore(
  contribution: ExpertAgentPluginContextContribution,
): ExpertAgentContextStore {
  if (isStoredContextArray(contribution)) {
    return createInMemoryContextStore({ context: contribution });
  }

  return contribution;
}

function isStoredContextArray(
  contribution: ExpertAgentPluginContextContribution,
): contribution is readonly ExpertAgentContextItemSeed[] {
  return Array.isArray(contribution);
}

function mergeModelProviders(
  providers: readonly IExpertAgentModelProviderConfig[],
): readonly IExpertAgentModelProviderConfig[] {
  const merged = new Map<string, IExpertAgentModelProviderConfig>();

  for (const provider of providers) {
    const existing = merged.get(provider.provider);

    if (existing === undefined) {
      merged.set(provider.provider, provider);
      continue;
    }

    merged.set(provider.provider, {
      provider: provider.provider,
      baseApi: provider.baseApi,
      key: provider.key,
      modelNames: dedupeStrings([...existing.modelNames, ...provider.modelNames]),
      ...mergeModelApi(provider.api),
    });
  }

  return [...merged.values()];
}

function mergeModelApi(api: ExpertAgentModelApi | undefined): {
  readonly api?: ExpertAgentModelApi;
} {
  return api === undefined ? {} : { api };
}

async function callHooks<TName extends keyof ExpertAgentPluginHooks>(
  hooks: readonly ExpertAgentPluginHooks[],
  name: TName,
  context: Parameters<NonNullable<ExpertAgentPluginHooks[TName]>>[0],
): Promise<void> {
  for (const hookGroup of hooks) {
    const hook = hookGroup[name];

    if (hook !== undefined) {
      await (hook as (value: typeof context) => MaybePromise<void>)(context);
    }
  }
}

function dedupeBy<TValue>(
  values: readonly TValue[],
  getKey: (value: TValue) => string,
): readonly TValue[] {
  const seen = new Set<string>();
  const deduped: TValue[] = [];

  for (const value of values) {
    const key = getKey(value);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function assertUniquePluginIds(pluginEntries: readonly ExpertAgentPluginEntry[]): void {
  const seen = new Set<string>();

  for (const plugin of pluginEntries) {
    if (plugin.id.length === 0 || plugin.id.includes("/")) {
      throw new Error(
        `ExpertAgent plugin id must be non-empty and must not contain "/": ${plugin.id}`,
      );
    }

    if (plugin.id === HOST_CONTEXT_NAMESPACE) {
      throw new Error(`ExpertAgent plugin id is reserved: ${plugin.id}`);
    }

    if (seen.has(plugin.id)) {
      throw new Error(`Duplicate ExpertAgent plugin id: ${plugin.id}`);
    }

    seen.add(plugin.id);
  }
}

function readExpertAgentPluginManifestFromCaller(): ExpertAgentPluginManifest {
  const callerFile = findDefinePluginEntryCallerFile();

  if (callerFile === undefined) {
    throw new Error(
      "Unable to locate plugin.json: definePluginEntry caller could not be resolved.",
    );
  }

  const manifestPath = findNearestPluginManifest(callerFile);

  if (manifestPath === undefined) {
    throw new Error(
      `Unable to load ExpertAgent plugin: plugin.json was not found for ${callerFile}.`,
    );
  }

  return readExpertAgentPluginManifest(manifestPath);
}

function findDefinePluginEntryCallerFile(): string | undefined {
  const stack = new Error().stack?.split("\n").slice(1) ?? [];
  const currentFile = fileURLToPath(import.meta.url);

  for (const line of stack) {
    const file = parseStackFrameFile(line);

    if (file !== undefined && file !== currentFile) {
      return file;
    }
  }

  return undefined;
}

function parseStackFrameFile(line: string): string | undefined {
  const match = /(?:\(|\s)(file:\/\/[^:)]+|\/[^:)]+):\d+:\d+\)?$/.exec(line.trim());
  const value = match?.[1];

  if (value === undefined) {
    return undefined;
  }

  return value.startsWith("file://") ? fileURLToPath(value) : value;
}

function findNearestPluginManifest(fromFile: string): string | undefined {
  let directory = dirname(fromFile);

  while (true) {
    const candidate = resolve(directory, "plugin.json");

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(directory);

    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}
