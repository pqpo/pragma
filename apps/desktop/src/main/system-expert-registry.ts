import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { derivePragmaResourceId, withFileLock } from "@pragma/core";
import {
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import {
  BUILT_IN_PRAGMA_REF,
  builtInPragmaFingerprint,
  builtInPragmaResource,
} from "@pragma/default-agent";
import { z } from "zod";

import {
  ExpertDefinitionSchema,
  ExpertSummarySchema,
  MissionExecutorOptionSchema,
  MissionExecutorSchema,
  UpdateBuiltInExpertDefinitionSchema,
  type ExpertDefinition,
  type ExpertSummary,
  type MissionExecutor,
  type MissionExecutorOption,
  type UpdateBuiltInExpertDefinition,
} from "../shared/desktop-api.ts";
import { desktopCapabilityBindingRef, desktopContextBindingRef } from "./desktop-binding-ref.ts";

const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const CONFIG_SCHEMA_VERSION = 3;

const SystemExpertCustomizationSchema = UpdateBuiltInExpertDefinitionSchema.extend({
  ref: z.literal(BUILT_IN_PRAGMA_REF),
  revision: z.number().int().min(2),
  updatedAt: z.string().datetime(),
});

const SystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  customizations: z.array(SystemExpertCustomizationSchema).max(100),
});

type SystemExpertCustomization = z.infer<typeof SystemExpertCustomizationSchema>;

export interface DesktopSystemExpertRegistry {
  initialize(): Promise<void>;
  list(): readonly ExpertSummary[];
  get(ref: string): ExpertDefinition | undefined;
  getResource(ref: string): PragmaExpertResource | undefined;
  getAdditionalResources(ref: string): readonly PragmaResource[];
  getExecutor(ref: string): MissionExecutor | undefined;
  listExecutors(): readonly MissionExecutorOption[];
  fingerprint(ref: string): string | undefined;
  isReservedRef(ref: string): boolean;
  isReservedId(id: string): boolean;
  update(ref: string, input: UpdateBuiltInExpertDefinition): Promise<ExpertDefinition>;
  reset(ref: string): Promise<ExpertDefinition>;
}

export function createDesktopSystemExpertRegistry(options?: {
  readonly configPath?: string | undefined;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): DesktopSystemExpertRegistry {
  const defaultResource = builtInPragmaResource();
  let customizations = new Map<string, SystemExpertCustomization>();

  const requireBuiltInRef = (ref: string): void => {
    if (ref !== BUILT_IN_PRAGMA_REF) throw new Error(`Built-in Expert not found: ${ref}`);
  };

  const effectiveResource = (): PragmaExpertResource => {
    const customization = customizations.get(BUILT_IN_PRAGMA_REF);
    if (customization === undefined) return defaultResource;
    return {
      ...defaultResource,
      metadata: {
        ...defaultResource.metadata,
        name: customization.name,
        description: customization.description,
        tags: customization.tags,
      },
      spec: {
        ...defaultResource.spec,
        instructions: appendAdditionalInstructions(
          defaultResource.spec.instructions,
          customization.additionalInstructions,
        ),
        capabilities: [
          ...defaultResource.spec.capabilities,
          ...customization.capabilities.map((capability) => ({
            ref: `capability:${desktopCapabilityResourceId(capability.capabilityId)}`,
            kind: capability.kind,
            ...(capability.kind === "tools" ? { tools: capability.toolNames } : {}),
          })),
        ],
        toolApprovals: {
          ...defaultResource.spec.toolApprovals,
          ...customization.toolApprovals,
        },
        plugins: customization.plugins.map((plugin) => ({
          ref: plugin.ref,
          ...(plugin.config === undefined ? {} : { config: plugin.config }),
          ...(plugin.secretBindings === undefined ? {} : { secretBindings: plugin.secretBindings }),
        })),
        contextStores: customization.contextStoreMounts.map((mount) => ({
          ref: `context-store:${desktopContextResourceId(mount.storeId)}`,
          namespace: desktopContextResourceId(mount.storeId),
          required: mount.enabled,
        })),
      },
    };
  };

  const definition = (): ExpertDefinition => {
    const resource = effectiveResource();
    const customization = customizations.get(BUILT_IN_PRAGMA_REF);
    return ExpertDefinitionSchema.parse({
      schemaVersion: "pragma.desktop-expert-view/v1",
      ref: BUILT_IN_PRAGMA_REF,
      id: resource.metadata.id,
      name: resource.metadata.name,
      description: resource.metadata.description,
      tags: resource.metadata.tags,
      scope: resource.spec.scope,
      instructions: defaultResource.spec.instructions,
      additionalInstructions: customization?.additionalInstructions ?? "",
      origin: "built-in",
      readOnly: true,
      customized: customization !== undefined,
      executionProfile:
        customization?.model === undefined
          ? { mode: "system-default" }
          : { mode: "pinned", model: customization.model },
      capabilities: customization?.capabilities ?? [],
      opaqueCapabilities: defaultResource.spec.capabilities,
      toolApprovals: customization?.toolApprovals ?? {},
      plugins: customization?.plugins ?? [],
      contextStoreMounts: customization?.contextStoreMounts ?? [],
      resourceTools: [],
      revision: customization?.revision ?? 1,
      createdAt: BUILT_IN_TIMESTAMP,
      updatedAt: customization?.updatedAt ?? BUILT_IN_TIMESTAMP,
    });
  };

  const readConfig = async (): Promise<Map<string, SystemExpertCustomization>> => {
    if (options?.configPath === undefined) return new Map(customizations);
    try {
      const parsed = SystemExpertCustomizationConfigSchema.parse(
        JSON.parse(await readFile(options.configPath, "utf8")),
      );
      return new Map(
        parsed.customizations.map((customization) => [customization.ref, customization]),
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return new Map();
      options.warn?.("System Expert customizations could not be read; using defaults.", error);
      return new Map();
    }
  };

  const writeConfig = async (
    next: ReadonlyMap<string, SystemExpertCustomization>,
  ): Promise<void> => {
    if (options?.configPath === undefined) return;
    const config = SystemExpertCustomizationConfigSchema.parse({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      customizations: [...next.values()],
    });
    await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.configPath), 0o700).catch(() => undefined);
    const temporaryPath = `${options.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, options.configPath);
    await chmod(options.configPath, 0o600).catch(() => undefined);
  };

  const mutate = async (operation: () => Promise<void>): Promise<void> => {
    if (options?.configPath === undefined) {
      await operation();
      return;
    }
    await withFileLock(`${options.configPath}.lock`, operation);
  };

  return {
    async initialize() {
      customizations = await readConfig();
    },
    list: () => [ExpertSummarySchema.parse(definition())],
    get: (ref) => (ref === BUILT_IN_PRAGMA_REF ? definition() : undefined),
    getResource: (ref) => (ref === BUILT_IN_PRAGMA_REF ? effectiveResource() : undefined),
    getAdditionalResources: (ref) =>
      ref === BUILT_IN_PRAGMA_REF ? customizationResources(customizations.get(ref)) : [],
    getExecutor: (ref) => {
      if (ref !== BUILT_IN_PRAGMA_REF) return undefined;
      const current = definition();
      return MissionExecutorSchema.parse({
        kind: "expert",
        ref: current.ref,
        name: current.name,
      });
    },
    listExecutors: () => {
      const current = definition();
      return [
        MissionExecutorOptionSchema.parse({
          kind: "expert",
          ref: current.ref,
          name: current.name,
          description: current.description,
          origin: current.origin,
          readOnly: current.readOnly,
          customized: current.customized,
        }),
      ];
    },
    fingerprint: (ref) =>
      ref === BUILT_IN_PRAGMA_REF
        ? builtInPragmaFingerprint(
            customizations.has(BUILT_IN_PRAGMA_REF) ? effectiveResource() : undefined,
            customizationResources(customizations.get(BUILT_IN_PRAGMA_REF)),
          )
        : undefined,
    isReservedRef: (ref) => ref === BUILT_IN_PRAGMA_REF,
    isReservedId: (id) => id === defaultResource.metadata.id,
    async update(ref, input) {
      requireBuiltInRef(ref);
      const parsed = UpdateBuiltInExpertDefinitionSchema.parse(input);
      await mutate(async () => {
        const latest = await readConfig();
        const current = latest.get(ref);
        latest.set(
          ref,
          SystemExpertCustomizationSchema.parse({
            ref,
            ...parsed,
            revision: (current?.revision ?? 1) + 1,
            updatedAt: new Date().toISOString(),
          }),
        );
        await writeConfig(latest);
        customizations = latest;
      });
      return definition();
    },
    async reset(ref) {
      requireBuiltInRef(ref);
      await mutate(async () => {
        const latest = await readConfig();
        latest.delete(ref);
        await writeConfig(latest);
        customizations = latest;
      });
      return definition();
    },
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function appendAdditionalInstructions(base: string, additional: string): string {
  const customization = additional.trim();
  return customization === "" ? base : `${base}\n\nUser customization:\n${customization}`;
}

function customizationResources(
  customization: SystemExpertCustomization | undefined,
): PragmaResource[] {
  if (customization === undefined) return [];
  const capabilities = customization.capabilities.map((capability) =>
    PragmaCapabilityResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "Capability",
      metadata: {
        id: desktopCapabilityResourceId(capability.capabilityId),
        name: `Capability ${capability.capabilityId}`,
        description: "Desktop-managed optional capability binding.",
        tags: ["desktop-managed", "system-expert-customization"],
      },
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: desktopCapabilityBindingRef(capability.capabilityId, capability.revision),
        config: { key: capability.capabilityId },
      },
    }),
  );
  const contexts = customization.contextStoreMounts.map((mount) =>
    PragmaContextStoreResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "ContextStore",
      metadata: {
        id: desktopContextResourceId(mount.storeId),
        name: `Context ${mount.storeId}`,
        description: "Desktop-managed optional context store binding.",
        tags: ["desktop-managed", "system-expert-customization"],
      },
      spec: {
        adapter: "pragma.context.host@v1",
        binding: desktopContextBindingRef(mount.storeId),
        config: { key: mount.storeId },
      },
    }),
  );
  return [...capabilities, ...contexts].filter(
    (resource, index, all) =>
      all.findIndex(
        (candidate) =>
          canonicalPragmaResourceRef(candidate) === canonicalPragmaResourceRef(resource),
      ) === index,
  );
}

function desktopCapabilityResourceId(id: string): string {
  return derivePragmaResourceId(`system-expert:capability:${id}`);
}

function desktopContextResourceId(id: string): string {
  return derivePragmaResourceId(`system-expert:context:${id}`);
}
