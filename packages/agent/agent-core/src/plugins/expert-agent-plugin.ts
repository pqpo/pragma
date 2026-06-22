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
  ExpertAgentDocumentSearchMatch,
  ExpertAgentDocumentSeed,
  ExpertAgentDocumentStore,
  ExpertAgentDocumentSummary,
} from "../documents/document-indexer.ts";
import { error, ok } from "../documents/document-indexer.ts";
import { createInMemoryDocumentStore } from "../documents/in-memory-document-store.ts";
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
  })
  .passthrough();

export type ExpertAgentPluginManifest = DeepReadonly<
  z.infer<typeof ExpertAgentPluginManifestSchema> & Record<string, unknown>
>;

export type ExpertAgentPluginMetadata = Pick<
  ExpertAgentPluginManifest,
  "id" | "name" | "description" | "version" | "tags"
>;

export type ExpertAgentPluginDocumentContribution =
  | ExpertAgentDocumentStore
  | readonly ExpertAgentDocumentSeed[];

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
  readonly documents?: ExpertAgentPluginDocumentContribution | undefined;
  readonly subAgents?: SubAgentRegistry | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
}

export interface ExpertAgentPluginEntry extends ExpertAgentPluginMetadata {
  readonly manifest: ExpertAgentPluginManifest;
  readonly setup: () => ExpertAgentPluginContributions;
}

export interface DefineExpertAgentPluginEntryOptions {
  readonly setup: () => ExpertAgentPluginContributions;
}

export interface ResolvedExpertAgentPluginContributions {
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly models?: IExpertAgentModelsConfig | undefined;
  readonly documents?: ExpertAgentDocumentStore | undefined;
  readonly subAgents?: SubAgentRegistry | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
}

export interface ResolveExpertAgentPluginsOptions {
  readonly host?: ExpertAgentPluginContributions | undefined;
  readonly plugins?: readonly ExpertAgentPluginEntry[] | undefined;
}

interface ExpertAgentDocumentStoreSource {
  readonly namespace?: string | undefined;
  readonly store: ExpertAgentDocumentStore;
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
    setup: options.setup,
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
  assertUniquePluginIds(options.plugins ?? []);
  const plugins = (options.plugins ?? []).map((plugin) => ({
    plugin,
    contributions: plugin.setup(),
  }));
  const contributions = [options.host, ...plugins.map((plugin) => plugin.contributions)].filter(
    (contribution): contribution is ExpertAgentPluginContributions => contribution !== undefined,
  );

  return {
    mcp: mergeMcpConfigs(contributions.map((contribution) => contribution.mcp)),
    skills: mergeSkillsConfigs(contributions.map((contribution) => contribution.skills)),
    models: mergeModelsConfigs(contributions.map((contribution) => contribution.models)),
    documents: mergeDocumentContributions(options.host?.documents, plugins),
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

function mergeDocumentContributions(
  hostDocuments: ExpertAgentPluginDocumentContribution | undefined,
  plugins: readonly {
    readonly plugin: ExpertAgentPluginEntry;
    readonly contributions: ExpertAgentPluginContributions;
  }[],
): ExpertAgentDocumentStore | undefined {
  const sources: ExpertAgentDocumentStoreSource[] = [
    ...(hostDocuments === undefined ? [] : [{ store: toDocumentStore(hostDocuments) }]),
    ...plugins.flatMap(({ plugin, contributions }) =>
      contributions.documents === undefined
        ? []
        : [
            {
              namespace: plugin.id,
              store: toDocumentStore(contributions.documents),
            },
          ],
    ),
  ];

  if (sources.length === 0) {
    return undefined;
  }

  return createCompositeDocumentStore(sources);
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

function createCompositeDocumentStore(
  sources: readonly ExpertAgentDocumentStoreSource[],
): ExpertAgentDocumentStore {
  const hostSource = sources.find((source) => source.namespace === undefined);
  const pluginSources = new Map(
    sources.flatMap((source) =>
      source.namespace === undefined ? [] : [[source.namespace, source] as const],
    ),
  );

  return {
    async listDocuments(input) {
      const summaries: ExpertAgentDocumentSummary[] = [];
      const seen = new Set<string>();

      for (const source of sources) {
        const result = await source.store.listDocuments(input);

        if (!result.ok) {
          return result;
        }

        for (const document of result.value.map((summary) =>
          prefixDocumentSummary(source.namespace, summary),
        )) {
          if (seen.has(document.id)) {
            continue;
          }

          seen.add(document.id);
          summaries.push(document);
        }
      }

      return ok(summaries);
    },
    async readDocument(input) {
      const route = resolveDocumentRoute(pluginSources, hostSource, input.id);

      if (route === undefined) {
        return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
      }

      const result = await route.source.store.readDocument({
        ...input,
        id: route.localId,
      });

      if (!result.ok) {
        return result;
      }

      return ok(prefixStoredDocument(route.source.namespace, result.value));
    },
    async createDocument(input) {
      const route = resolveWritableDocumentRoute(pluginSources, hostSource, input.id);

      if (route === undefined) {
        return error("store_unavailable", "ExpertAgent document store is not configured.");
      }

      const result = await route.source.store.createDocument({
        ...input,
        id: route.localId,
      });

      if (!result.ok) {
        return result;
      }

      return ok(prefixStoredDocument(route.source.namespace, result.value));
    },
    async updateDocument(input) {
      const route = resolveDocumentRoute(pluginSources, hostSource, input.id);

      if (route === undefined) {
        return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
      }

      const result = await route.source.store.updateDocument({
        ...input,
        id: route.localId,
      });

      if (!result.ok) {
        return result;
      }

      return ok(prefixStoredDocument(route.source.namespace, result.value));
    },
    async deleteDocument(input) {
      const route = resolveDocumentRoute(pluginSources, hostSource, input.id);

      if (route === undefined) {
        return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
      }

      const result = await route.source.store.deleteDocument({
        ...input,
        id: route.localId,
      });

      if (!result.ok) {
        return result;
      }

      return ok({ id: input.id });
    },
    async searchDocuments(input) {
      const matches: ExpertAgentDocumentSearchMatch[] = [];
      const maxResults = input.maxResults ?? 20;

      for (const source of sources) {
        const result = await source.store.searchDocuments({
          ...input,
          maxResults: maxResults - matches.length,
        });

        if (!result.ok) {
          return result;
        }

        matches.push(
          ...result.value.map((match) => prefixDocumentSearchMatch(source.namespace, match)),
        );

        if (matches.length >= maxResults) {
          return ok(matches.slice(0, maxResults));
        }
      }

      return ok(matches);
    },
  };
}

function toDocumentStore(
  contribution: ExpertAgentPluginDocumentContribution,
): ExpertAgentDocumentStore {
  if (isStoredDocumentArray(contribution)) {
    return createInMemoryDocumentStore({ documents: contribution });
  }

  return contribution;
}

function resolveDocumentRoute(
  pluginSources: ReadonlyMap<string, ExpertAgentDocumentStoreSource>,
  hostSource: ExpertAgentDocumentStoreSource | undefined,
  id: string,
):
  | {
      readonly source: ExpertAgentDocumentStoreSource;
      readonly localId: string;
    }
  | undefined {
  const parsed = parseNamespacedDocumentId(id);

  if (parsed !== undefined) {
    const source = pluginSources.get(parsed.namespace);

    if (source !== undefined) {
      return {
        source,
        localId: parsed.localId,
      };
    }
  }

  if (hostSource === undefined) {
    return undefined;
  }

  return {
    source: hostSource,
    localId: id,
  };
}

function resolveWritableDocumentRoute(
  pluginSources: ReadonlyMap<string, ExpertAgentDocumentStoreSource>,
  hostSource: ExpertAgentDocumentStoreSource | undefined,
  id: string,
):
  | {
      readonly source: ExpertAgentDocumentStoreSource;
      readonly localId: string;
    }
  | undefined {
  const route = resolveDocumentRoute(pluginSources, hostSource, id);

  if (route !== undefined) {
    return route;
  }

  return hostSource === undefined
    ? undefined
    : {
        source: hostSource,
        localId: id,
      };
}

function parseNamespacedDocumentId(
  id: string,
): { readonly namespace: string; readonly localId: string } | undefined {
  const separatorIndex = id.indexOf("/");

  if (separatorIndex <= 0 || separatorIndex === id.length - 1) {
    return undefined;
  }

  return {
    namespace: id.slice(0, separatorIndex),
    localId: id.slice(separatorIndex + 1),
  };
}

function prefixDocumentId(namespace: string | undefined, id: string): string {
  return namespace === undefined ? id : `${namespace}/${id}`;
}

function prefixDocumentSummary(
  namespace: string | undefined,
  summary: ExpertAgentDocumentSummary,
): ExpertAgentDocumentSummary {
  return {
    ...summary,
    id: prefixDocumentId(namespace, summary.id),
  };
}

function prefixStoredDocument<TDocument extends { readonly id: string }>(
  namespace: string | undefined,
  document: TDocument,
): TDocument {
  return {
    ...document,
    id: prefixDocumentId(namespace, document.id),
  };
}

function prefixDocumentSearchMatch(
  namespace: string | undefined,
  match: ExpertAgentDocumentSearchMatch,
): ExpertAgentDocumentSearchMatch {
  return {
    ...match,
    id: prefixDocumentId(namespace, match.id),
  };
}

function isStoredDocumentArray(
  contribution: ExpertAgentPluginDocumentContribution,
): contribution is readonly ExpertAgentDocumentSeed[] {
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

function assertUniquePluginIds(plugins: readonly ExpertAgentPluginEntry[]): void {
  const seen = new Set<string>();

  for (const plugin of plugins) {
    if (plugin.id.length === 0 || plugin.id.includes("/")) {
      throw new Error(
        `ExpertAgent plugin id must be non-empty and must not contain "/": ${plugin.id}`,
      );
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
    throw new Error("Unable to locate plugin.json: definePluginEntry caller could not be resolved.");
  }

  const manifestPath = findNearestPluginManifest(callerFile);

  if (manifestPath === undefined) {
    throw new Error(`Unable to load ExpertAgent plugin: plugin.json was not found for ${callerFile}.`);
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
