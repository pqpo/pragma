import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import {
  BUILT_IN_AGENT_REFS,
  BUILT_IN_PRAGMA_REF,
  STORE_REVISION_EXPERT_REF,
  builtInAgentFingerprint,
  builtInAgentResource,
} from "@pragma/built-in-agents";
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
} from "../../../shared/contracts/index.ts";
import {
  createDesktopCapabilityResource,
  createDesktopContextResource,
  desktopCapabilityResourceId,
  desktopContextResourceId,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";

const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const CONFIG_SCHEMA_VERSION = 5;
const LEGACY_BUILT_IN_PRAGMA_REF = "expert:pragma@1.0.0";

const SystemExpertCustomizationSchema = UpdateBuiltInExpertDefinitionSchema.extend({
  ref: z.enum([BUILT_IN_PRAGMA_REF, STORE_REVISION_EXPERT_REF]),
  revision: z.number().int().min(2),
  updatedAt: z.string().datetime(),
});

const SystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  customizations: z.array(SystemExpertCustomizationSchema).max(100),
});

const LegacySystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(3),
  customizations: z
    .array(
      UpdateBuiltInExpertDefinitionSchema.extend({
        ref: z.literal(LEGACY_BUILT_IN_PRAGMA_REF),
        revision: z.number().int().min(2),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(100),
});

const PreviousSystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(4),
  customizations: z
    .array(
      UpdateBuiltInExpertDefinitionSchema.extend({
        ref: z.literal(BUILT_IN_PRAGMA_REF),
        revision: z.number().int().min(2),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(100),
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
  upgradeCapabilityRevision(capabilityId: string, revision: number): Promise<boolean>;
  reset(ref: string): Promise<ExpertDefinition>;
}

export function createDesktopSystemExpertRegistry(options?: {
  readonly configPath?: string | undefined;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): DesktopSystemExpertRegistry {
  const editableRefs = [BUILT_IN_PRAGMA_REF, STORE_REVISION_EXPERT_REF] as const;
  const defaultResources = new Map<string, PragmaExpertResource>(
    editableRefs.map((ref) => [ref, builtInAgentResource(ref)] as const),
  );
  const reservedRefs = new Set<string>(BUILT_IN_AGENT_REFS);
  const reservedIds = new Set(BUILT_IN_AGENT_REFS.map((ref) => ref.slice("expert:".length)));
  let customizations = new Map<string, SystemExpertCustomization>();

  const requireBuiltInRef = (ref: string): void => {
    if (!defaultResources.has(ref)) throw new Error(`Built-in Expert not found: ${ref}`);
  };

  const effectiveResource = (ref: string): PragmaExpertResource => {
    const defaultResource = defaultResources.get(ref);
    if (defaultResource === undefined) throw new Error(`Built-in Expert not found: ${ref}`);
    const customization = customizations.get(ref);
    if (customization === undefined) return defaultResource;
    return {
      ...defaultResource,
      metadata: {
        ...defaultResource.metadata,
        avatarId: customization.avatarId ?? defaultResource.metadata.avatarId,
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
            ref: `capability:${desktopCapabilityResourceId("system-expert-customization", capability.capabilityId)}`,
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
          ref: `context-store:${desktopContextResourceId("system-expert-customization", mount.storeId)}`,
          namespace: desktopContextResourceId("system-expert-customization", mount.storeId),
          required: mount.enabled,
        })),
      },
    };
  };

  const definition = (ref: string): ExpertDefinition => {
    const defaultResource = defaultResources.get(ref);
    if (defaultResource === undefined) throw new Error(`Built-in Expert not found: ${ref}`);
    const resource = effectiveResource(ref);
    const customization = customizations.get(ref);
    return ExpertDefinitionSchema.parse({
      schemaVersion: "pragma.desktop-expert-view/v1",
      ref,
      id: resource.metadata.id,
      avatarId: resource.metadata.avatarId,
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
      const raw = JSON.parse(await readFile(options.configPath, "utf8")) as unknown;
      const current = SystemExpertCustomizationConfigSchema.safeParse(raw);
      if (current.success) {
        if (options.configPath !== undefined) {
          await Promise.all(
            ([3, 4] as const).map(
              async (sourceVersion) =>
                await rm(
                  `${options.configPath}.migration-v${sourceVersion}-to-v${CONFIG_SCHEMA_VERSION}.json`,
                  { force: true },
                ),
            ),
          );
        }
        return new Map(
          current.data.customizations.map((customization) => [customization.ref, customization]),
        );
      }
      const previous = PreviousSystemExpertCustomizationConfigSchema.safeParse(raw);
      if (previous.success) {
        const migrated = new Map<string, SystemExpertCustomization>(
          previous.data.customizations.map((customization) => {
            const parsed = SystemExpertCustomizationSchema.parse(customization);
            return [parsed.ref, parsed];
          }),
        );
        await migrateConfig(raw, 4, migrated);
        return migrated;
      }
      const legacy = LegacySystemExpertCustomizationConfigSchema.parse(raw);
      const migrated = new Map<string, SystemExpertCustomization>(
        legacy.customizations.map((customization) => {
          const parsed = SystemExpertCustomizationSchema.parse({
            ...customization,
            ref: BUILT_IN_PRAGMA_REF,
          });
          return [parsed.ref, parsed];
        }),
      );
      await migrateConfig(raw, 3, migrated);
      return migrated;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return new Map();
      options.warn?.("System Expert customizations could not be read.", error);
      throw error;
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

  const migrateConfig = async (
    source: unknown,
    sourceVersion: 3 | 4,
    migrated: ReadonlyMap<string, SystemExpertCustomization>,
  ): Promise<void> => {
    if (options?.configPath === undefined) return;
    const journalPath = `${options.configPath}.migration-v${sourceVersion}-to-v${CONFIG_SCHEMA_VERSION}.json`;
    const backupPath = `${options.configPath}.v${sourceVersion}.backup.json`;
    await writePrivateJson(journalPath, {
      schemaVersion: "pragma.system-expert-customization-migration/v1",
      sourceVersion,
      targetVersion: CONFIG_SCHEMA_VERSION,
      backupPath,
    });
    await writePrivateJson(backupPath, source);
    await writeConfig(migrated);
    await rm(journalPath, { force: true });
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
      await mutate(async () => {
        customizations = await readConfig();
      });
    },
    list: () => editableRefs.map((ref) => ExpertSummarySchema.parse(definition(ref))),
    get: (ref) => (defaultResources.has(ref) ? definition(ref) : undefined),
    getResource: (ref) => (defaultResources.has(ref) ? effectiveResource(ref) : undefined),
    getAdditionalResources: (ref) =>
      defaultResources.has(ref) ? customizationResources(customizations.get(ref)) : [],
    getExecutor: (ref) => {
      if (!defaultResources.has(ref)) return undefined;
      const current = definition(ref);
      return MissionExecutorSchema.parse({
        kind: "expert",
        ref: current.ref,
        name: current.name,
        avatarId: current.avatarId,
      });
    },
    listExecutors: () => {
      return editableRefs.map((ref) => {
        const current = definition(ref);
        return MissionExecutorOptionSchema.parse({
          kind: "expert",
          ref: current.ref,
          name: current.name,
          avatarId: current.avatarId,
          description: current.description,
          origin: current.origin,
          readOnly: current.readOnly,
          customized: current.customized,
        });
      });
    },
    fingerprint: (ref) => {
      if (!defaultResources.has(ref)) return undefined;
      return builtInAgentFingerprint(
        ref as (typeof editableRefs)[number],
        customizations.has(ref) ? effectiveResource(ref) : undefined,
        customizationResources(customizations.get(ref)),
      );
    },
    isReservedRef: (ref) => reservedRefs.has(ref),
    isReservedId: (id) => reservedIds.has(id),
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
      return definition(ref);
    },
    async upgradeCapabilityRevision(capabilityId, revision) {
      let changed = false;
      await mutate(async () => {
        const latest = await readConfig();
        for (const [ref, customization] of latest) {
          if (
            !customization.capabilities.some(
              (capability) =>
                capability.capabilityId === capabilityId && capability.revision !== revision,
            )
          ) {
            continue;
          }
          latest.set(
            ref,
            SystemExpertCustomizationSchema.parse({
              ...customization,
              capabilities: customization.capabilities.map((capability) =>
                capability.capabilityId === capabilityId ? { ...capability, revision } : capability,
              ),
              revision: customization.revision + 1,
              updatedAt: new Date().toISOString(),
            }),
          );
          changed = true;
        }
        if (changed) await writeConfig(latest);
        customizations = latest;
      });
      return changed;
    },
    async reset(ref) {
      requireBuiltInRef(ref);
      await mutate(async () => {
        const latest = await readConfig();
        latest.delete(ref);
        await writeConfig(latest);
        customizations = latest;
      });
      return definition(ref);
    },
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
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
    createDesktopCapabilityResource({
      owner: "system-expert-customization",
      capabilityId: capability.capabilityId,
      revision: capability.revision,
    }),
  );
  const contexts = customization.contextStoreMounts.map((mount) =>
    createDesktopContextResource({
      owner: "system-expert-customization",
      storeId: mount.storeId,
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
