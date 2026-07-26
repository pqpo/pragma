import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Validator, type Schema } from "@cfworker/json-schema";
import { z } from "zod";

import type {
  Expert,
  IExpertAgentMcpConfig,
  IExpertAgentModelsConfig,
  IExpertAgentSkillsConfig,
} from "../agent/expert-agent.ts";
import { ContextSystem, HOST_CONTEXT_NAMESPACE } from "../context-system/context-system.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import type {
  RuntimeTaskSubmission,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeSessionRef,
} from "../runtime/runtime-adapter.ts";
import type { RuntimeStreamEvent } from "../runtime/stream-events.ts";
import type { PragmaLogger, PragmaLoggerProvider } from "../logging/logger.ts";
import { createPragmaLogger, defaultPragmaLoggerProvider } from "../logging/logger.ts";
import type {
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
} from "../tools/managed-tool.ts";
import { mergeExpertAgentToolApprovals } from "../tools/managed-tool.ts";

type MaybePromise<TValue> = TValue | Promise<TValue>;
const PLUGIN_CONFIGURATION_SCHEMA_KEYWORDS = new Set([
  "$id",
  "$schema",
  "$comment",
  "type",
  "title",
  "description",
  "default",
  "examples",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "enum",
  "const",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "x-pragma-secret",
]);
export type DeepReadonly<TValue> = TValue extends (...args: never[]) => unknown
  ? TValue
  : TValue extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : TValue extends object
      ? { readonly [TKey in keyof TValue]: DeepReadonly<TValue[TKey]> }
      : TValue;
const PluginIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const PluginVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/);

const PluginEntryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return (
      !entry.includes("\0") &&
      !isAbsolute(entry) &&
      !/^[A-Za-z]:\//.test(normalized) &&
      !normalized.startsWith("/") &&
      !normalized.split("/").includes("..")
    );
  }, "Plugin runtime entry must stay inside the plugin package.");

const ExpertAgentPluginCapabilitySchema = z
  .object({
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
  })
  .strict();

export const ExpertAgentPluginConfigurationSchema = z
  .record(z.string(), z.unknown())
  .superRefine((schema, context) => validatePluginConfigurationSchema(schema, context));

const ExpertAgentPluginPermissionsSchema = z
  .object({
    filesystem: z.array(z.string().trim().min(1)).refine(hasUniqueStrings),
    shell: z.array(z.string().trim().min(1)).refine(hasUniqueStrings),
    network: z.array(z.string().trim().min(1)).refine(hasUniqueStrings),
    environment: z.array(z.string().trim().min(1)).refine(hasUniqueStrings),
  })
  .strict();

export const ExpertAgentPluginManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.plugin/v2"),
    id: PluginIdentifierSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    version: PluginVersionSchema,
    tags: z.array(z.string().min(1)).default([]),
    runtime: z
      .object({
        type: z.literal("expert-agent-plugin"),
        entry: PluginEntryPathSchema,
        trust: z.literal("trusted-host"),
      })
      .strict(),
    capabilities: z.array(ExpertAgentPluginCapabilitySchema).default([]),
    configuration: ExpertAgentPluginConfigurationSchema,
    permissions: ExpertAgentPluginPermissionsSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.configuration["type"] !== "object") {
      context.addIssue({
        code: "custom",
        message: "Plugin configuration must be a JSON Schema with an object root.",
        path: ["configuration", "type"],
      });
    }
  });

export type ExpertAgentPluginManifest = DeepReadonly<
  z.infer<typeof ExpertAgentPluginManifestSchema>
>;

export type ExpertAgentPluginMetadata = Pick<
  ExpertAgentPluginManifest,
  "id" | "name" | "description" | "version" | "tags"
>;

export interface ExpertAgentPluginSessionCreateContext {
  readonly agent: Expert;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly systemSessionId: string;
  readonly runtimeSession?: RuntimeSessionRef | undefined;
  readonly processEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly logger?: PragmaLogger | undefined;
}

export interface ExpertAgentProcessEnvironmentPatch {
  readonly set?: Readonly<Record<string, string>> | undefined;
  readonly unset?: readonly string[] | undefined;
}

export interface ExpertAgentPluginSessionPreparation {
  readonly processEnvironment?: ExpertAgentProcessEnvironmentPatch | undefined;
}

export interface ExpertAgentPluginSessionContext {
  readonly agent: Expert;
  readonly session: RuntimeSessionInfo;
  readonly logger?: PragmaLogger | undefined;
}

export interface ExpertAgentPluginTaskSubmitContext<TOutput = unknown> {
  readonly agent: Expert;
  readonly session: RuntimeSessionInfo;
  readonly runId: string;
  readonly submission: RuntimeTaskSubmission<TOutput>;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly logger?: PragmaLogger | undefined;
}

export interface ExpertAgentPluginTaskSubmittedContext<
  TOutput = unknown,
> extends ExpertAgentPluginTaskSubmitContext<TOutput> {
  readonly result?: RuntimeRunResult<TOutput> | undefined;
  readonly error?: unknown;
}

export interface ExpertAgentPluginToolCallContext {
  readonly agent: Expert;
  readonly toolName: string;
  readonly toolCallId?: string | undefined;
  readonly args: unknown;
  readonly runId?: string | undefined;
  readonly logger?: PragmaLogger | undefined;
}

export interface ExpertAgentPluginToolCalledContext extends ExpertAgentPluginToolCallContext {
  readonly durationMs: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface ExpertAgentPluginStreamEventContext {
  readonly agent: Expert;
  readonly session: RuntimeSessionInfo;
  readonly runId: string;
  readonly event: RuntimeStreamEvent;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly logger?: PragmaLogger | undefined;
}

export interface ExpertAgentPluginSetupContext {
  readonly agent?:
    | {
        readonly id: string;
        readonly displayName: string;
      }
    | undefined;
  readonly host: ExpertAgentPluginContributions;
  readonly contextSystem: ContextSystem;
  readonly workspaceRoot: string;
  readonly userConfig: DeepReadonly<Record<string, unknown>>;
  readonly hostBindings: Readonly<Record<string, unknown>>;
  readonly logger: PragmaLogger;
}

export interface ExpertAgentPluginHooks {
  readonly beforeSessionCreate?:
    | ((
        context: ExpertAgentPluginSessionCreateContext,
      ) => MaybePromise<ExpertAgentPluginSessionPreparation | void>)
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
  readonly onStreamEvent?:
    | ((context: ExpertAgentPluginStreamEventContext) => MaybePromise<void>)
    | undefined;
}

export interface ExpertAgentPluginContributions {
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly models?: IExpertAgentModelsConfig | undefined;
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
  readonly userConfig?: Readonly<Record<string, unknown>> | undefined;
  readonly hostBindings?: Readonly<Record<string, unknown>> | undefined;
}

export interface DefineExpertAgentPluginEntryOptions {
  readonly manifest: ExpertAgentPluginManifest;
  readonly setup: (context: ExpertAgentPluginSetupContext) => ExpertAgentPluginContributions;
}

export interface ResolvedExpertAgentPluginContributions {
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly models?: IExpertAgentModelsConfig | undefined;
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
      }
    | undefined;
  readonly host?: ExpertAgentPluginContributions | undefined;
  readonly contextSystem?: ContextSystem | undefined;
  readonly pluginEntries?:
    | readonly (ExpertAgentPluginEntry | ExpertAgentPluginRegistration)[]
    | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly agentId?: string | undefined;
}

export function definePluginEntry(
  options: DefineExpertAgentPluginEntryOptions,
): ExpertAgentPluginEntry {
  const manifest = deepFreeze(ExpertAgentPluginManifestSchema.parse(options.manifest));

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    tags: manifest.tags,
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
  const registrations = (options.pluginEntries ?? []).map(normalizePluginRegistration);
  assertUniquePluginIds(registrations.map((registration) => registration.entry));
  const host = options.host ?? {};
  const loggerProvider = options.loggerProvider ?? defaultPragmaLoggerProvider;
  const baseContext = {
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    host,
    contextSystem: options.contextSystem ?? new ContextSystem(),
    workspaceRoot: options.workspaceRoot ?? "",
  };
  const pluginEntries = registrations.map((registration) => {
    const userConfig = resolveExpertAgentPluginConfig(registration.entry.manifest, [
      registration.userConfig ?? {},
    ]);

    return {
      plugin: registration.entry,
      contributions: registration.entry.setup({
        ...baseContext,
        userConfig,
        hostBindings: registration.hostBindings ?? {},
        logger: createPragmaLogger(loggerProvider, {
          component: "plugin",
          scope: {
            agentId: options.agentId,
            pluginId: registration.entry.id,
          },
        }),
      }),
    };
  });
  const contributions = [
    ...(options.host === undefined
      ? []
      : [{ source: "host", contribution: options.host } as const]),
    ...pluginEntries.map((plugin) => ({
      source: `plugin:${plugin.plugin.id}@${plugin.plugin.version}`,
      contribution: plugin.contributions,
    })),
  ];

  return {
    mcp: mergeMcpConfigs(contributions.map(({ contribution }) => contribution.mcp)),
    skills: mergeSkillsConfigs(contributions.map(({ contribution }) => contribution.skills)),
    models: mergeModelsConfigs(contributions.map(({ contribution }) => contribution.models)),
    tools: mergeManagedTools(contributions.map(({ contribution }) => contribution.tools)),
    toolApprovals: mergeToolApprovals(
      contributions.map(({ contribution }) => contribution.toolApprovals),
    ),
    hooks: mergePluginHooks(
      contributions.map(({ source, contribution }) => ({ source, hooks: contribution.hooks })),
    ),
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

export function resolveExpertAgentPluginConfig(
  manifest: ExpertAgentPluginManifest,
  layers: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown> {
  const defaults = readJsonSchemaDefaults(manifest.configuration as Record<string, unknown>);
  const config = layers.reduce((current, layer) => mergePlainObjects(current, layer), defaults);
  const result = new Validator(manifest.configuration as Schema, "2020-12", false).validate(config);
  if (!result.valid) {
    throw new Error(
      `Plugin ${manifest.id} config is invalid: ${result.errors.map((error) => `${error.instanceLocation || "/"}: ${error.error}`).join("; ")}`,
    );
  }
  return deepFreeze(config);
}

export function mergeExpertAgentPluginConfig(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeExpertAgentPluginConfig(existing, value)
        : value;
  }

  return merged;
}

const mergePlainObjects = mergeExpertAgentPluginConfig;

export function setExpertAgentPluginConfigPath(
  config: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validatePluginConfigurationSchema(
  schema: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  try {
    new Validator(schema as Schema, "2020-12", false).validate({});
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: `Invalid plugin configuration JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  visitPluginConfigurationSchema(schema, [], context);
}

function visitPluginConfigurationSchema(
  schema: unknown,
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  if (!isPlainObject(schema)) return;
  for (const key of Object.keys(schema)) {
    if (!PLUGIN_CONFIGURATION_SCHEMA_KEYWORDS.has(key)) {
      context.addIssue({
        code: "custom",
        message: `Unsupported plugin configuration schema keyword: ${key}.`,
        path: [...path, key],
      });
    }
  }
  if ("$ref" in schema || "$recursiveRef" in schema) {
    context.addIssue({
      code: "custom",
      message: "Plugin configuration schemas cannot use references.",
      path: [...path, "$ref"],
    });
  }
  if (schema["type"] === "object" && schema["additionalProperties"] !== false) {
    context.addIssue({
      code: "custom",
      message: "Object configuration schemas must set additionalProperties to false.",
      path: [...path, "additionalProperties"],
    });
  }
  if (schema["x-pragma-secret"] === true && schema["default"] !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Secret plugin configuration cannot declare a plaintext default.",
      path: [...path, "default"],
    });
  }
  if (schema["x-pragma-secret"] !== undefined && typeof schema["x-pragma-secret"] !== "boolean") {
    context.addIssue({
      code: "custom",
      message: "x-pragma-secret must be a boolean.",
      path: [...path, "x-pragma-secret"],
    });
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isPlainObject(value)) {
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        visitPluginConfigurationSchema(propertySchema, [...path, key, propertyName], context);
      }
      continue;
    }
    if (["items", "if", "then", "else", "not", "contains"].includes(key)) {
      visitPluginConfigurationSchema(value, [...path, key], context);
      continue;
    }
    if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(value)) {
      value.forEach((item, index) =>
        visitPluginConfigurationSchema(item, [...path, key, index], context),
      );
    }
  }
}

function readJsonSchemaDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const properties = schema["properties"];
  if (!isPlainObject(properties)) return defaults;
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!isPlainObject(propertySchema)) continue;
    if (propertySchema["default"] !== undefined) {
      defaults[name] = structuredClone(propertySchema["default"]);
      continue;
    }
    if (propertySchema["type"] === "object") {
      const nested = readJsonSchemaDefaults(propertySchema);
      if (Object.keys(nested).length > 0) defaults[name] = nested;
    }
  }
  return defaults;
}

export async function dispatchExpertAgentHook<TName extends keyof ExpertAgentPluginHooks>(
  hooks: ExpertAgentPluginHooks | undefined,
  name: TName,
  context: Parameters<NonNullable<ExpertAgentPluginHooks[TName]>>[0],
): Promise<Awaited<ReturnType<NonNullable<ExpertAgentPluginHooks[TName]>>> | undefined> {
  const hook = hooks?.[name];

  if (hook === undefined) {
    return;
  }

  return await (
    hook as (
      value: typeof context,
    ) => MaybePromise<Awaited<ReturnType<NonNullable<ExpertAgentPluginHooks[TName]>>>>
  )(context);
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
  const selection = configs.findLast((config) => config?.default !== undefined)?.default;
  return selection === undefined ? undefined : { default: selection };
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
  hookGroups: readonly {
    readonly source: string;
    readonly hooks: ExpertAgentPluginHooks | undefined;
  }[],
): ExpertAgentPluginHooks | undefined {
  const hooks = hookGroups.filter(
    (hookGroup): hookGroup is { readonly source: string; readonly hooks: ExpertAgentPluginHooks } =>
      hookGroup.hooks !== undefined,
  );

  if (hooks.length === 0) {
    return undefined;
  }

  return {
    beforeSessionCreate: async (context) => {
      const patches: {
        readonly source: string;
        readonly patch: ExpertAgentProcessEnvironmentPatch;
      }[] = [];
      for (const { source, hooks: hookGroup } of hooks) {
        const preparation = await hookGroup.beforeSessionCreate?.(context);
        if (preparation?.processEnvironment !== undefined) {
          patches.push({ source, patch: preparation.processEnvironment });
        }
      }
      const processEnvironment = mergeProcessEnvironmentPatches(patches);
      return processEnvironment === undefined ? undefined : { processEnvironment };
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
    onStreamEvent: async (context) => {
      await callHooks(hooks, "onStreamEvent", context);
    },
  };
}

async function callHooks<TName extends keyof ExpertAgentPluginHooks>(
  hooks: readonly { readonly hooks: ExpertAgentPluginHooks }[],
  name: TName,
  context: Parameters<NonNullable<ExpertAgentPluginHooks[TName]>>[0],
): Promise<void> {
  for (const hookGroup of hooks) {
    const hook = hookGroup.hooks[name];

    if (hook !== undefined) {
      await (hook as (value: typeof context) => MaybePromise<void>)(context);
    }
  }
}

function mergeProcessEnvironmentPatches(
  contributions: readonly {
    readonly source: string;
    readonly patch: ExpertAgentProcessEnvironmentPatch;
  }[],
): ExpertAgentProcessEnvironmentPatch | undefined {
  const claims = new Map<
    string,
    { readonly source: string; readonly operation: "set" | "unset"; readonly value?: string }
  >();

  for (const { source, patch } of contributions) {
    const ownUnset = new Set(patch.unset ?? []);
    for (const name of Object.keys(patch.set ?? {})) {
      if (ownUnset.has(name)) {
        throw new Error(`Process environment patch both sets and unsets ${name}: ${source}.`);
      }
    }
    for (const name of patch.unset ?? []) {
      claimProcessEnvironment(claims, name, { source, operation: "unset" });
    }
    for (const [name, value] of Object.entries(patch.set ?? {})) {
      claimProcessEnvironment(claims, name, { source, operation: "set", value });
    }
  }

  if (claims.size === 0) {
    return undefined;
  }

  return {
    set: Object.fromEntries(
      [...claims].flatMap(([name, claim]) =>
        claim.operation === "set" ? [[name, claim.value!]] : [],
      ),
    ),
    unset: [...claims].flatMap(([name, claim]) => (claim.operation === "unset" ? [name] : [])),
  };
}

function claimProcessEnvironment(
  claims: Map<
    string,
    { readonly source: string; readonly operation: "set" | "unset"; readonly value?: string }
  >,
  name: string,
  claim: { readonly source: string; readonly operation: "set" | "unset"; readonly value?: string },
): void {
  if (name.length === 0 || name.includes("=") || name.includes("\0")) {
    throw new Error(`Invalid process environment variable name from ${claim.source}.`);
  }
  const existing = claims.get(name);
  if (
    existing !== undefined &&
    (existing.operation !== claim.operation || existing.value !== claim.value)
  ) {
    throw new Error(
      `Conflicting process environment variable ${name}: ${existing.source} and ${claim.source}.`,
    );
  }
  claims.set(name, existing ?? claim);
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

function assertUniquePluginIds(pluginEntries: readonly ExpertAgentPluginEntry[]): void {
  const seen = new Set<string>();

  for (const plugin of pluginEntries) {
    if (plugin.id.length === 0 || plugin.id.includes("/")) {
      throw new Error(`Expert plugin id must be non-empty and must not contain "/": ${plugin.id}`);
    }

    if (plugin.id === HOST_CONTEXT_NAMESPACE) {
      throw new Error(`Expert plugin id is reserved: ${plugin.id}`);
    }

    if (seen.has(plugin.id)) {
      throw new Error(`Duplicate Expert plugin id: ${plugin.id}`);
    }

    seen.add(plugin.id);
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
