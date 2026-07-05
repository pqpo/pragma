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
import { ContextSystem, HOST_CONTEXT_NAMESPACE } from "../context-system/context-system.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import type {
  RuntimeSubmitRequest,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeSessionRef,
} from "../runtime/runtime-adapter.ts";
import type { ExpertAgentLogger, ExpertAgentLoggerProvider } from "../logging/logger.ts";
import { createExpertAgentLogger, defaultExpertAgentLoggerProvider } from "../logging/logger.ts";
import type { SubAgentRegistry } from "../subagents/sub-agent.ts";
import type {
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
} from "../tools/managed-tool.ts";
import { mergeExpertAgentToolApprovals } from "../tools/managed-tool.ts";

type MaybePromise<TValue> = TValue | Promise<TValue>;
type DeepReadonly<TValue> = TValue extends (...args: never[]) => unknown
  ? TValue
  : TValue extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : TValue extends object
      ? { readonly [TKey in keyof TValue]: DeepReadonly<TValue[TKey]> }
      : TValue;

const ExpertAgentPluginCapabilitySchema = z.looseObject({
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
});

const ExpertAgentPluginRequiredConfigSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  secret: z.boolean().default(false),
});

const ExpertAgentPluginConfigurationPropertySchema = z.looseObject({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string().min(1),
  required: z.boolean().default(false),
  secret: z.boolean().default(false),
  default: z.unknown().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const ExpertAgentPluginConfigurationSchema = z.looseObject({
  properties: z.array(ExpertAgentPluginConfigurationPropertySchema).default([]),
});

const ExpertAgentPluginManifestSchema = z.looseObject({
  schemaVersion: z.literal("pragma.plugin/v1"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  runtime: z.looseObject({
    type: z.string().min(1),
    entry: z.string().min(1),
  }),
  capabilities: z.array(ExpertAgentPluginCapabilitySchema).default([]),
  configuration: ExpertAgentPluginConfigurationSchema.default({ properties: [] }),
  required_config: z.array(ExpertAgentPluginRequiredConfigSchema).default([]),
});

export type ExpertAgentPluginManifest = DeepReadonly<
  z.infer<typeof ExpertAgentPluginManifestSchema> & Record<string, unknown>
>;

export type ExpertAgentPluginMetadata = Pick<
  ExpertAgentPluginManifest,
  "id" | "name" | "description" | "version" | "tags"
>;

export interface ExpertAgentPluginSessionCreateContext {
  readonly agent: ExpertAgent;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly systemSessionId: string;
  readonly runtimeSession?: RuntimeSessionRef | undefined;
  readonly logger?: ExpertAgentLogger | undefined;
}

export interface ExpertAgentPluginSessionContext {
  readonly agent: ExpertAgent;
  readonly session: RuntimeSessionInfo;
  readonly logger?: ExpertAgentLogger | undefined;
}

export interface ExpertAgentPluginTaskSubmitContext<TOutput = unknown> {
  readonly agent: ExpertAgent;
  readonly session: RuntimeSessionInfo;
  readonly runId: string;
  readonly submission: RuntimeSubmitRequest<TOutput>;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly logger?: ExpertAgentLogger | undefined;
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
  readonly logger?: ExpertAgentLogger | undefined;
}

export interface ExpertAgentPluginToolCalledContext extends ExpertAgentPluginToolCallContext {
  readonly durationMs: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface ExpertAgentPluginSetupContext {
  readonly agent?:
    | {
        readonly id: string;
        readonly displayName: string;
        readonly version: string;
      }
    | undefined;
  readonly host: ExpertAgentPluginContributions;
  readonly contextSystem: ContextSystem;
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config?: unknown | undefined;
  readonly logger: ExpertAgentLogger;
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
  readonly subAgents?: SubAgentRegistry | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly toolApprovals?:
    | readonly {
        readonly toolName: string;
        readonly approval: ExpertAgentToolApproval;
      }[]
    | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
}

export interface ExpertAgentPluginEntry extends ExpertAgentPluginMetadata {
  readonly manifest: ExpertAgentPluginManifest;
  readonly setup: (context: ExpertAgentPluginSetupContext) => ExpertAgentPluginContributions;
}

export interface ExpertAgentPluginRegistration {
  readonly entry: ExpertAgentPluginEntry;
  readonly config?: unknown | undefined;
}

export interface DefineExpertAgentPluginEntryOptions {
  readonly setup: (context: ExpertAgentPluginSetupContext) => ExpertAgentPluginContributions;
}

export interface ResolvedExpertAgentPluginContributions {
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly models?: IExpertAgentModelsConfig | undefined;
  readonly subAgents?: SubAgentRegistry | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly toolApprovals?:
    | readonly {
        readonly toolName: string;
        readonly approval: ExpertAgentToolApproval;
      }[]
    | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
}

export interface ResolveExpertAgentPluginsOptions {
  readonly agent?:
    | {
        readonly id: string;
        readonly displayName: string;
        readonly version: string;
      }
    | undefined;
  readonly host?: ExpertAgentPluginContributions | undefined;
  readonly contextSystem?: ContextSystem | undefined;
  readonly pluginEntries?:
    | readonly (ExpertAgentPluginEntry | ExpertAgentPluginRegistration)[]
    | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly agentId?: string | undefined;
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

export function createExpertAgentPluginConfigEnvName(options: {
  readonly pluginId: string;
  readonly name: string;
}): string {
  return `PRAGMA_PLUGIN_${toEnvSegment(options.pluginId)}_${toEnvSegment(options.name)}`;
}

export function resolveExpertAgentPlugins(
  options: ResolveExpertAgentPluginsOptions,
): ResolvedExpertAgentPluginContributions {
  const registrations = (options.pluginEntries ?? []).map(normalizePluginRegistration);
  assertUniquePluginIds(registrations.map((registration) => registration.entry));
  const host = options.host ?? {};
  const loggerProvider = options.loggerProvider ?? defaultExpertAgentLoggerProvider;
  const baseContext = {
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    host,
    contextSystem: options.contextSystem ?? new ContextSystem(),
    workspaceRoot: options.workspaceRoot ?? "",
    env: options.env ?? process.env,
  };
  const pluginEntries = registrations.map((registration) => {
    const config = resolvePluginConfig(registration, baseContext.env);

    return {
      plugin: registration.entry,
      contributions: registration.entry.setup({
        ...baseContext,
        ...(config === undefined ? {} : { config }),
        logger: createExpertAgentLogger(loggerProvider, {
          component: "plugin",
          agentId: options.agentId,
          pluginId: registration.entry.id,
        }),
      }),
    };
  });
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
    subAgents: mergeSubAgentRegistries(contributions.map((contribution) => contribution.subAgents)),
    tools: mergeManagedTools(contributions.map((contribution) => contribution.tools)),
    toolApprovals: mergeToolApprovals(
      contributions.map((contribution) => contribution.toolApprovals),
    ),
    hooks: mergePluginHooks(contributions.map((contribution) => contribution.hooks)),
  };
}

function normalizePluginRegistration(
  plugin: ExpertAgentPluginEntry | ExpertAgentPluginRegistration,
): ExpertAgentPluginRegistration {
  if ("entry" in plugin) {
    return plugin;
  }

  return { entry: plugin };
}

function resolvePluginConfig(
  registration: ExpertAgentPluginRegistration,
  env: NodeJS.ProcessEnv,
): unknown | undefined {
  const envConfig = readPluginEnvConfig(registration.entry.manifest, env);
  const explicitConfig = readExplicitPluginConfig(registration);
  const config = mergePlainObjects(envConfig, explicitConfig ?? {});
  const missingConfig = findMissingRequiredConfig(registration.entry.manifest, config);

  if (missingConfig.length > 0) {
    const missing = missingConfig
      .map(
        (item) =>
          `${item.name} (${createExpertAgentPluginConfigEnvName({
            pluginId: registration.entry.manifest.id,
            name: item.name,
          })})`,
      )
      .join(", ");
    throw new Error(`Plugin ${registration.entry.manifest.id} requires missing config: ${missing}`);
  }

  return Object.keys(config).length === 0 ? undefined : config;
}

function readPluginEnvConfig(
  manifest: ExpertAgentPluginManifest,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (const item of manifest.required_config) {
    const envName = createExpertAgentPluginConfigEnvName({
      pluginId: manifest.id,
      name: item.name,
    });
    const value = readEnv(env, envName);

    if (value !== undefined) {
      setConfigPath(config, item.name, value);
    }
  }

  return config;
}

function readExplicitPluginConfig(
  registration: ExpertAgentPluginRegistration,
): Record<string, unknown> | undefined {
  if (registration.config === undefined) {
    return undefined;
  }

  if (
    registration.config !== null &&
    typeof registration.config === "object" &&
    !Array.isArray(registration.config)
  ) {
    return registration.config as Record<string, unknown>;
  }

  throw new Error(`Plugin ${registration.entry.manifest.id} config must be an object.`);
}

function findMissingRequiredConfig(
  manifest: ExpertAgentPluginManifest,
  config: Record<string, unknown>,
): readonly { readonly name: string }[] {
  return manifest.required_config.flatMap((item) => {
    const value = readConfigPath(config, item.name);

    if (value === undefined || (typeof value === "string" && value.length === 0)) {
      return [{ name: item.name }];
    }

    return [];
  });
}

function mergePlainObjects(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergePlainObjects(existing, value) : value;
  }

  return merged;
}

function setConfigPath(config: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split(".").filter((part) => part.length > 0);
  let cursor = config;

  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];

    if (!isPlainObject(next)) {
      cursor[part] = {};
    }

    cursor = cursor[part] as Record<string, unknown>;
  }

  const leaf = parts.at(-1);

  if (leaf !== undefined) {
    cursor[leaf] = value;
  }
}

function readConfigPath(config: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = config;

  for (const part of path.split(".").filter((item) => item.length > 0)) {
    if (!isPlainObject(cursor)) {
      return undefined;
    }

    cursor = cursor[part];
  }

  return cursor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];

  return value === undefined || value.length === 0 ? undefined : value;
}

function toEnvSegment(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
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

function mergeToolApprovals(
  approvalGroups: readonly (
    | readonly {
        readonly toolName: string;
        readonly approval: ExpertAgentToolApproval;
      }[]
    | undefined
  )[],
):
  | readonly {
      readonly toolName: string;
      readonly approval: ExpertAgentToolApproval;
    }[]
  | undefined {
  const approvalByTool = new Map<string, ExpertAgentToolApproval>();
  const approvals: {
    readonly toolName: string;
    readonly approval: ExpertAgentToolApproval;
  }[] = [];

  for (const contribution of approvalGroups.flatMap((group) => group ?? [])) {
    const mergedApproval = mergeExpertAgentToolApprovals(
      approvalByTool.get(contribution.toolName),
      contribution.approval,
    );

    if (mergedApproval === undefined) {
      continue;
    }

    const existingIndex = approvals.findIndex(
      (approval) => approval.toolName === contribution.toolName,
    );
    approvalByTool.set(contribution.toolName, mergedApproval);

    if (existingIndex === -1) {
      approvals.push({
        toolName: contribution.toolName,
        approval: mergedApproval,
      });
    } else {
      approvals[existingIndex] = {
        toolName: contribution.toolName,
        approval: mergedApproval,
      };
    }
  }

  return approvals.length === 0 ? undefined : approvals;
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
