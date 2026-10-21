import { normalizeHostBoundResources } from "../projects/resource-normalization.ts";
import { isDeepStrictEqual } from "node:util";
import {
  planBundleResources,
  collectBundleResourceClosure,
  bundleRuntimeModels,
} from "./pragma-bundle-resources.ts";
import { resolveCapabilityForBinding } from "../capabilities/capability-verification.ts";
import { capabilityToolNames } from "../capabilities/capability-revision-coordinator.ts";
import { inspectAssetReadiness } from "../asset-transfer/asset-transfer-readiness.ts";
import {
  readTransferredSkill,
  readTransferredKnowledge,
  publishTransferredSkill,
  appendTransferredKnowledge,
} from "../asset-transfer/asset-transfer-payloads.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  PRAGMA_MANAGEMENT_CAPABILITY_REF,
  pragmaManagementCapabilityResource,
} from "@pragma/built-in-agents";

import {
  PragmaPaths,
  applyAtomicStateMigration,
  bundleInstallationsMigrationChain,
  BundleInstallationsCatalogV8Schema,
  generatePragmaResourceId,
  recoverAtomicStateMigration,
  withFileLock,
} from "@pragma/core";
import {
  PragmaBundleFormatError,
  PragmaProjectValidationError,
  collectPragmaProjectArtifactPaths,
  decodePragmaBundle,
  loadPragmaProject,
  localizePragmaBundleResources,
  remapPragmaResourceIdentities,
  remapPragmaProjectArtifactPaths,
  type DecodedPragmaBundle,
  type PragmaBundleRequirement,
} from "@pragma/interpreter";
import {
  PragmaBundleRootRefSchema,
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaForwardCompatibleResourceSchema,
  PragmaInvocableResourceRefSchema,
  PragmaResourceRefSchema,
  canonicalPragmaResourceRef,
  normalizePragmaResourceName,
  type PragmaInvocableResource,
  type PragmaResource,
  type PragmaResourceRef,
} from "@pragma/interpreter/ast";
import { strFromU8 } from "fflate";
import {
  assertValidSkillBundlePayload,
  SkillBundlePayloadDescriptorSchema,
  serializeSkillBundleAssetIdentity,
  serializeSkillBundleFileManifest,
  serializeSkillBundleDefinition,
  type SkillBundleFile,
} from "@pragma/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import {
  StartPragmaBundleImportSchema,
  CreateCapabilitySchema,
  CapabilityDefinitionSchema,
  CapabilityIdSchema,
  ContextStoreSnapshotSchema,
  PragmaBundleExportPreviewSchema,
  PragmaBundleExportResultSchema,
  PragmaBundleImportInspectionSchema,
  PragmaBundleInstallationSchema,
  type PragmaBundleDependencyReadiness,
  WorkflowLayoutSchema,
  type ExportPragmaBundle,
  type PragmaBundleExportPreview,
  type PragmaBundleImportInspection,
  type PragmaBundleInstallation,
  ResolvePragmaBundleInstallationSchema,
  type ResolvePragmaBundleInstallation,
  type StartPragmaBundleImport,
  type DesktopRuntimeAvailability,
} from "../../deployment-contracts/index.ts";
import {
  classifyHostCapabilityResource,
  bindExistingDesktopCapabilityResource,
  bindExistingDesktopContextResource,
} from "../bindings.ts";
import { parseDesktopCapabilityBindingRef, parseDesktopContextBindingRef } from "../bindings.ts";
import {
  CapabilityStoreError,
  portableSkillDirectoryContentHashes,
  type CapabilityStore,
} from "../capabilities/capability-store.ts";
import { scanSkillWorkingTree } from "../capabilities/skill-revision-draft-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import { writeBundleAtomically } from "./pragma-bundle-file.ts";
import {
  BundleInstallationConflictError,
  BundlePluginUnavailableError,
} from "./pragma-bundle-errors.ts";
import {
  assertUniqueResolutionRefs,
  collectCapabilities,
  collectContexts,
  isPortableValue,
  mergePendingMetadata,
  pendingBinding,
  readinessToPending,
  runtimeDependencyAvailable,
  unique,
} from "./pragma-bundle-dependencies.ts";
import { findBundleAssetConflicts, nextBundleAssetCopyName } from "./pragma-bundle-assets.ts";
import {
  artifactPathIsReferenced,
  findBundleConflicts,
  isBundleOwnedArtifact,
  resolveBundleIdentities,
} from "./pragma-bundle-resources.ts";

const InstallationCatalogSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-installations/v9"),
    installations: z.array(PragmaBundleInstallationSchema),
  })
  .strict();

type DesktopProjectSnapshot = Awaited<ReturnType<PragmaProjectStore["get"]>>;
type BundleAssetResolution = NonNullable<StartPragmaBundleImport["assetConflicts"]>[number];

function isPragmaManagementCapability(resource: PragmaResource): boolean {
  return canonicalPragmaResourceRef(resource) === PRAGMA_MANAGEMENT_CAPABILITY_REF;
}

const DesktopContextPayloadDescriptorSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const DesktopCapabilityPayloadDescriptorV2Schema = z
  .object({
    schemaVersion: z.literal("pragma.desktop.capability-descriptor/v2"),
    logicalId: CapabilityIdSchema,
    revision: z.number().int().positive(),
    definition: CapabilityDefinitionSchema,
    revisions: z
      .array(
        z
          .object({
            revision: z.number().int().positive(),
            definition: CapabilityDefinitionSchema,
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.revisions === undefined) return;
    const current = value.revisions.find((revision) => revision.revision === value.revision);
    if (current === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability descriptor history must include the bound revision.",
        path: ["revisions"],
      });
      return;
    }
    if (stableStringify(current.definition) !== stableStringify(value.definition)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability descriptor history conflicts with the bound definition.",
        path: ["definition"],
      });
    }
  });

const DesktopCapabilityPayloadDescriptorV3Schema = z
  .object({
    schemaVersion: z.literal("pragma.desktop.capability-descriptor/v3"),
    assetKey: CapabilityIdSchema,
    definition: CapabilityDefinitionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const DesktopContextPayloadDescriptorV2Schema = z
  .object({
    schemaVersion: z.literal("pragma.desktop.context-store-descriptor/v2"),
    sourceId: z.string().uuid(),
    name: z.string().min(1),
    description: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    contentIncluded: z.boolean(),
  })
  .strict();

const DesktopContextPayloadDescriptorV3Schema = z
  .object({
    schemaVersion: z.literal("pragma.desktop.context-store-descriptor/v3"),
    name: z.string().min(1),
    description: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    contentIncluded: z.boolean(),
    snapshot: ContextStoreSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.contentIncluded !== (descriptor.snapshot !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Knowledge-base snapshot presence must match contentIncluded.",
        path: ["snapshot"],
      });
    }
  });

const DesktopContextPayloadSnapshotV4Schema = z
  .object({
    schemaVersion: ContextStoreSnapshotSchema.shape.schemaVersion,
    storeId: ContextStoreSnapshotSchema.shape.storeId,
    revision: ContextStoreSnapshotSchema.shape.revision,
    snapshotHash: ContextStoreSnapshotSchema.shape.snapshotHash,
    createdAt: ContextStoreSnapshotSchema.shape.createdAt,
    directories: ContextStoreSnapshotSchema.shape.directories,
    files: z.array(ContextStoreSnapshotSchema.shape.files.element.omit({ content: true })),
  })
  .strict();

const DesktopContextPayloadDescriptorV4Schema = z
  .object({
    schemaVersion: z.literal("pragma.desktop.context-store-descriptor/v4"),
    name: z.string().min(1),
    description: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    contentIncluded: z.boolean(),
    snapshot: DesktopContextPayloadSnapshotV4Schema.optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.contentIncluded !== (descriptor.snapshot !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Knowledge-base snapshot presence must match contentIncluded.",
        path: ["snapshot"],
      });
    }
  });

function findIncompleteInstallation(
  installations: readonly PragmaBundleInstallation[],
  bundleFingerprint: string,
  sourceRootRef: string,
): PragmaBundleInstallation | undefined {
  return installations
    .filter(
      (installation) =>
        installation.bundleFingerprint === bundleFingerprint &&
        installation.sourceRootRef === sourceRootRef &&
        installation.status !== "ready",
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function assertResolutionTargets(
  resolutions: readonly { readonly resourceRef: string }[],
  allowedRefs: ReadonlySet<string>,
  label: string,
): void {
  for (const resolution of resolutions) {
    if (!allowedRefs.has(resolution.resourceRef)) {
      throw new Error(`${label} is not requested by this Bundle: ${resolution.resourceRef}.`);
    }
  }
}

function assertRequirementTargets(
  resolutions: readonly { readonly requirementId: string }[],
  allowedIds: ReadonlySet<string>,
  label: string,
): void {
  for (const resolution of resolutions) {
    if (!allowedIds.has(resolution.requirementId)) {
      throw new Error(`${label} is not requested by this Bundle: ${resolution.requirementId}.`);
    }
  }
}

function sameConflictResolutions(
  left: readonly {
    readonly resourceRef: string;
    readonly action: "update" | "copy" | "keep_local";
  }[],
  right: readonly {
    readonly resourceRef: string;
    readonly action: "update" | "copy" | "keep_local";
  }[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByRef = new Map(
    right.map((resolution) => [resolution.resourceRef, resolution.action]),
  );
  return left.every((resolution) => rightByRef.get(resolution.resourceRef) === resolution.action);
}

function throwBundleExportValidationError(error: unknown): never {
  if (!(error instanceof PragmaProjectValidationError)) throw error;
  const visibleDiagnostics = error.diagnostics.slice(0, 5);
  const details = visibleDiagnostics
    .map((diagnostic) => {
      const location =
        diagnostic.source ?? (diagnostic.path.length === 0 ? undefined : diagnostic.path.join("."));
      return `${location === undefined ? "" : `${location}: `}${diagnostic.message}`;
    })
    .join("; ");
  const omitted = error.diagnostics.length - visibleDiagnostics.length;
  throw new Error(
    `Bundle export validation failed.${details.length === 0 ? "" : ` ${details}`}${
      omitted > 0 ? ` (${omitted} more validation issues)` : ""
    }`,
    { cause: error },
  );
}

export interface PragmaBundleService {
  initialize(): Promise<void>;
  suggestExportFilename(input: {
    readonly rootRef: string;
    readonly projectRevision: number;
  }): Promise<string>;
  prepareExport(input: {
    readonly rootRef: string;
    readonly projectRevision: number;
  }): Promise<PragmaBundleExportPreview>;
  exportTo(
    input: ExportPragmaBundle,
    destinationPath: string,
  ): Promise<{
    readonly path: string;
    readonly bundleFingerprint: string;
    readonly projectFingerprint: string;
  }>;
  inspect(
    sourcePath: string,
    rootRef?: string,
    decisions?: Pick<StartPragmaBundleImport, "conflicts">,
  ): Promise<PragmaBundleImportInspection>;
  inspectInstallation(installationId: string): Promise<PragmaBundleImportInspection>;
  startImport(input: StartPragmaBundleImport): Promise<PragmaBundleInstallation>;
  listInstallations(): Promise<readonly PragmaBundleInstallation[]>;
  recheckInstallation(installationId: string): Promise<PragmaBundleInstallation>;
  resolveInstallation(input: ResolvePragmaBundleInstallation): Promise<PragmaBundleInstallation>;
  discardInstallation(installationId: string): Promise<void>;
  rebindInstallation(input: ResolvePragmaBundleInstallation): Promise<PragmaBundleInstallation>;
  getReadinessForRef(
    ref: string,
    input?: {
      readonly snapshot: DesktopProjectSnapshot;
      readonly runtimes: readonly DesktopRuntimeAvailability[];
    },
  ): Promise<readonly PragmaBundleDependencyReadiness[]>;
  isRefPending(ref: string): Promise<boolean>;
}

export function createPragmaBundleService(options: {
  readonly paths: PragmaPaths;
  readonly project: PragmaProjectStore;
  readonly capabilities: CapabilityStore;
  readonly contextStores: ContextStoreStore;
  readonly plugins: PluginStore;
  readonly layouts: WorkflowLayoutStore;
  readonly getRuntimes: () => Promise<readonly DesktopRuntimeAvailability[]>;
}): PragmaBundleService {
  const readCatalogFile = async (): Promise<z.infer<typeof InstallationCatalogSchema>> => {
    try {
      return InstallationCatalogSchema.parse(
        JSON.parse(await readFile(options.paths.bundleInstallationsCatalog(), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: "pragma.bundle-installations/v9", installations: [] };
      }
      throw error;
    }
  };
  let initialization: Promise<void> | undefined;

  const localSkillAssetFingerprint = async (
    capability: Awaited<ReturnType<CapabilityStore["get"]>>,
  ): Promise<string> => {
    if (capability.definition.kind !== "skill") {
      throw new Error(`Capability is not a Skill: ${capability.manifest.id}.`);
    }
    const payloadPath = await options.capabilities.skillFilesPath(
      capability.manifest.id,
      capability.manifest.latestRevision,
    );
    const snapshot = await scanSkillWorkingTree(payloadPath);
    return skillAssetFingerprint(
      capability.definition,
      sha256(serializeSkillBundleFileManifest(snapshot.entries)),
    );
  };

  const writeCatalog = async (
    catalog: z.infer<typeof InstallationCatalogSchema>,
  ): Promise<void> => {
    const path = options.paths.bundleInstallationsCatalog();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  };

  const updateInstallationFile = async (
    id: string,
    update: (current: PragmaBundleInstallation) => PragmaBundleInstallation,
  ): Promise<PragmaBundleInstallation> =>
    await withFileLock(options.paths.bundleInstallationsLock(), async () => {
      const catalog = await readCatalogFile();
      const current = catalog.installations.find((item) => item.id === id);
      if (current === undefined) throw new Error(`Bundle installation not found: ${id}`);
      const next = PragmaBundleInstallationSchema.parse(update(current));
      await writeCatalog({
        ...catalog,
        installations: catalog.installations.map((item) => (item.id === id ? next : item)),
      });
      return next;
    });

  const addInstallationFile = async (
    installation: PragmaBundleInstallation,
  ): Promise<PragmaBundleInstallation> =>
    await withFileLock(options.paths.bundleInstallationsLock(), async () => {
      const catalog = await readCatalogFile();
      await writeCatalog({
        ...catalog,
        installations: [...catalog.installations, installation],
      });
      return installation;
    });

  const removeInstallationRecordFile = async (id: string): Promise<void> => {
    await withFileLock(options.paths.bundleInstallationsLock(), async () => {
      const catalog = await readCatalogFile();
      await writeCatalog({
        ...catalog,
        installations: catalog.installations.filter((item) => item.id !== id),
      });
    });
    await rm(options.paths.bundleInstallationStateRoot(id), { recursive: true, force: true });
  };

  const recoverKnowledgeBaseInstallation = async (
    installation: PragmaBundleInstallation,
  ): Promise<void> => {
    const update = installation.knowledgeBaseUpdate;
    if (installation.rootKind !== "ContextStore" || update === undefined) {
      throw new Error(
        "This legacy installation has no recoverable write journal. Try safe discard before importing again. If cleanup is blocked, preserve its data and restore the project from a known backup before retrying.",
      );
    }
    const archive = await readDesktopBundle(
      options.paths.bundleInstallationArchive(installation.id),
      installation.sourceRootRef,
      true,
    );
    const dependency = archive.manifest.dependencies.contextStores.find(
      (candidate) => candidate.resourceRef === update.sourceRef,
    );
    if (
      dependency?.snapshot === undefined ||
      dependency.snapshot.snapshotHash !== update.importedSnapshotHash
    ) {
      throw new Error("The interrupted knowledge-base import journal does not match its archive.");
    }
    const importedName = update.importedName ?? dependency.name;
    const importedDescription = update.importedDescription ?? dependency.description;
    const importedFingerprint = knowledgeBaseAssetFingerprint({
      name: importedName,
      description: importedDescription,
      snapshotHash: update.importedSnapshotHash,
    });
    let store = (await options.contextStores.list()).find(
      (candidate) => candidate.id === update.storeId,
    );
    if (store === undefined) {
      if (update.baseRevision !== undefined || update.baseSnapshotHash !== undefined) {
        throw new Error("The knowledge base targeted by the interrupted import is unavailable.");
      }
      store = await options.contextStores.createFromSnapshot({
        id: update.storeId,
        name: importedName,
        description: importedDescription,
        directories: dependency.snapshot.directories,
        files: dependency.snapshot.files,
        author: "import",
        summary: "Recover interrupted knowledge-base Bundle import.",
        expectedSnapshotHash: dependency.snapshot.snapshotHash,
      });
    } else {
      const snapshot = await options.contextStores.getSnapshot(store.id);
      const currentFingerprint = knowledgeBaseAssetFingerprint({
        name: store.name,
        description: store.description,
        snapshotHash: snapshot.snapshotHash,
      });
      if (currentFingerprint !== importedFingerprint) {
        const contentAlreadyApplied = snapshot.snapshotHash === update.importedSnapshotHash;
        if (
          !contentAlreadyApplied &&
          (snapshot.revision !== update.baseRevision ||
            snapshot.snapshotHash !== update.baseSnapshotHash)
        ) {
          throw new Error(
            "The target knowledge base changed after an interrupted import. Inspect the Bundle again.",
          );
        }
        await appendTransferredKnowledge(
          options.contextStores,
          {
            storeId: store.id,
            baseRevision: snapshot.revision,
            baseSnapshotHash: snapshot.snapshotHash,
            snapshotHash: dependency.snapshot.snapshotHash,
            directories: dependency.snapshot.directories,
            files: dependency.snapshot.files,
            summary: "Recover interrupted knowledge-base Bundle import.",
            name: importedName,
            description: importedDescription,
          },
          "import",
        );
      }
    }
    await updateInstallationFile(installation.id, (record) => ({
      ...record,
      createdContextStoreIds:
        update.baseRevision === undefined
          ? unique([...record.createdContextStoreIds, update.storeId])
          : record.createdContextStoreIds,
      knowledgeBaseUpdate: { ...update, phase: "applied" },
      updatedAt: new Date().toISOString(),
    }));

    const current = await options.project.get();
    const existing = current.resources.find(
      (resource) => canonicalPragmaResourceRef(resource) === update.targetRef,
    );
    if (
      existing !== undefined &&
      (existing.kind !== "ContextStore" ||
        parseDesktopContextBindingRef(existing.spec.binding ?? "") !== store.id)
    ) {
      throw new Error(
        "The target knowledge-base binding changed after the interrupted import. Inspect the Bundle again.",
      );
    }
    if (existing === undefined) {
      const source = archive.resources.find(
        (resource) => canonicalPragmaResourceRef(resource) === update.sourceRef,
      );
      if (source?.kind !== "ContextStore") {
        throw new Error("The interrupted knowledge-base Bundle root is unavailable.");
      }
      const targetId = update.targetRef.slice("context-store:".length);
      const localized = {
        ...source,
        metadata: { ...source.metadata, id: targetId },
      };
      const bound = bindExistingDesktopContextResource(localized, store.id, {
        name: store.name,
        description: store.description,
      });
      await options.project.upsert({ baseRevision: current.revision, resource: bound });
    }
    const published = await options.project.get();
    await updateInstallationFile(installation.id, (record) => ({
      ...record,
      projectRevision: published.revision,
      rootRef: update.targetRef,
      rootName: store.name,
      resourceRefs: unique([...record.resourceRefs, update.targetRef]),
      status: "ready",
      pending: [],
      readiness: [],
      error: undefined,
      errorCode: undefined,
      updatedAt: new Date().toISOString(),
    }));
    await rm(options.paths.bundleInstallationArchive(installation.id), { force: true });
  };

  const initializeImpl = async (): Promise<void> => {
    const aggregateRoot = options.paths.bundleInstallationsStateRoot();
    const catalogFile = "installations.json";
    const journalFile = join(aggregateRoot, "state-migration.json");
    await mkdir(aggregateRoot, { recursive: true, mode: 0o700 });
    await withFileLock(options.paths.bundleInstallationsLock(), async () => {
      const migrationResource = {
        family: "pragma.bundle-installations",
        id: "desktop",
      } as const;
      const validateDocuments = (documents: Readonly<Record<string, unknown>>) => {
        const document = documents[catalogFile];
        if (
          typeof document === "object" &&
          document !== null &&
          "schemaVersion" in document &&
          document.schemaVersion === "pragma.bundle-installations/v8"
        )
          BundleInstallationsCatalogV8Schema.parse(document);
        else InstallationCatalogSchema.parse(document);
      };
      await recoverAtomicStateMigration({
        aggregateRoot,
        journalFile,
        resource: migrationResource,
        validateDocuments,
      });
      try {
        const source = JSON.parse(
          await readFile(options.paths.bundleInstallationsCatalog(), "utf8"),
        ) as unknown;
        const upgraded = bundleInstallationsMigrationChain.upgrade(source);
        if (upgraded.migrated) {
          await applyAtomicStateMigration({
            aggregateRoot,
            journalFile,
            resource: migrationResource,
            fromVersion: upgraded.fromVersion,
            toVersion: upgraded.toVersion,
            documents: { [catalogFile]: upgraded.value },
            validateDocuments,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  };

  const ensureInitialized = async (): Promise<void> => {
    if (initialization !== undefined) return await initialization;
    const operation = initializeImpl();
    initialization = operation;
    try {
      await operation;
    } catch (error) {
      if (initialization === operation) initialization = undefined;
      throw error;
    }
  };

  const readCatalog = async (): Promise<z.infer<typeof InstallationCatalogSchema>> => {
    await ensureInitialized();
    return await readCatalogFile();
  };

  const updateInstallation = async (
    id: string,
    update: (current: PragmaBundleInstallation) => PragmaBundleInstallation,
  ): Promise<PragmaBundleInstallation> => {
    await ensureInitialized();
    return await updateInstallationFile(id, update);
  };

  const addInstallation = async (
    installation: PragmaBundleInstallation,
  ): Promise<PragmaBundleInstallation> => {
    await ensureInitialized();
    return await addInstallationFile(installation);
  };

  const removeInstallationRecord = async (id: string): Promise<void> => {
    await ensureInitialized();
    await removeInstallationRecordFile(id);
  };

  const cleanupInstallationArchive = async (id: string): Promise<void> => {
    await rm(options.paths.bundleInstallationArchive(id), { force: true }).catch(() => undefined);
  };

  const prepare = async (rootRef: string, projectRevision: number) => {
    const snapshot = await options.project.get();
    if (snapshot.revision !== projectRevision) {
      throw new Error(
        `Project revision changed from ${projectRevision} to ${snapshot.revision}. Reopen the export dialog.`,
      );
    }
    let project = await options.project.openRevision(projectRevision);
    let exportRoot: string | undefined;
    const dispose = async () => {
      try {
        await project.dispose();
      } finally {
        if (exportRoot !== undefined) await rm(exportRoot, { recursive: true, force: true });
      }
    };
    try {
      // Export a derived project: caller-specific model overrides must not travel with Experts.
      // Normalize the full revision before selecting the closure: an alias outside the
      // requested root still participates in the same identity choice as an explicit save.
      const normalized = await options.project.normalizeResources(snapshot.resources);
      const named = await normalizeHostBoundResources(normalized.resources, {
        canonicalCapabilityId: (id) =>
          normalized.resources.find(
            (resource) => classifyHostCapabilityResource(resource)?.id === id,
          )?.metadata.id,
        capabilityName: async (id) =>
          (await options.capabilities.resolveActive(id).catch(() => undefined))?.definition.name,
      });
      rootRef = normalized.aliases.get(rootRef) ?? rootRef;
      const sourceResources = project.listResourceClosure(PragmaBundleRootRefSchema.parse(rootRef));
      const portableResources = collectBundleResourceClosure(named.resources, rootRef);
      let changed = !isDeepStrictEqual(portableResources, sourceResources);
      for (const resource of portableResources) {
        if (resource.kind === "ExpertTeam") {
          changed ||= Object.keys(resource.spec.delegation.runtimes).length > 0;
          resource.spec.delegation.runtimes = {};
        } else if (resource.kind === "Expert") {
          for (const tool of resource.spec.tools) {
            if (tool.policy === undefined) continue;
            changed ||= Object.keys(tool.policy.runtimes ?? {}).length > 0;
            tool.policy.runtimes = {};
          }
        }
      }
      if (changed) {
        const retained = collectBundleResourceClosure(portableResources, rootRef);
        const artifactPaths = collectPragmaProjectArtifactPaths(retained);
        exportRoot = await mkdtemp(join(tmpdir(), "pragma-bundle-export-"));
        if (artifactPaths.length > 0) {
          const artifacts = await options.project.readArtifacts(projectRevision);
          for (const [path, contents] of artifacts) {
            if (
              !artifactPaths.some(
                (prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/+$/, "")}/`),
              )
            )
              continue;
            const destination = join(exportRoot, path);
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await writeFile(destination, contents, { mode: 0o600 });
          }
        }
        const entry = join(exportRoot, "pragma.yaml");
        await writeFile(
          entry,
          stringifyYaml({
            apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
            kind: "Bundle",
            resources: retained,
          }),
          { mode: 0o600 },
        );
        const derived = await loadPragmaProject(entry);
        await project.dispose();
        project = derived;
      }
      const resources = project.listResourceClosure(PragmaBundleRootRefSchema.parse(rootRef));
      const root = resources.find(
        (
          resource,
        ): resource is Extract<
          PragmaResource,
          { kind: "Expert" | "ExpertTeam" | "Flow" | "ContextStore" | "Capability" }
        > =>
          canonicalPragmaResourceRef(resource) === rootRef &&
          (resource.kind === "Expert" ||
            resource.kind === "ExpertTeam" ||
            resource.kind === "Flow" ||
            resource.kind === "ContextStore" ||
            resource.kind === "Capability"),
      );
      if (root === undefined) throw new Error(`Bundle root not found: ${rootRef}`);
      const capabilities = await collectCapabilities(resources, options.capabilities);
      if (root.kind === "Capability") {
        const rootCapability = capabilities.find(
          (entry) => canonicalPragmaResourceRef(entry.resource) === rootRef,
        )?.capability;
        if (rootCapability?.definition.kind !== "skill" || rootCapability.managedBy === "system") {
          throw new Error(
            "Only a user-managed Skill with an active ready revision can be exported.",
          );
        }
      }
      const contexts = await collectContexts(resources, options.contextStores);
      if (
        resources.some((resource) => resource.kind === "Expert" && resource.spec.plugins.length > 0)
      ) {
        throw new BundlePluginUnavailableError("export");
      }
      const flows = resources.filter((resource) => resource.kind === "Flow");
      return {
        snapshot,
        project,
        root,
        resources,
        capabilities,
        contexts,
        flows,
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  };

  const currentInstallationResources = async (
    installation: PragmaBundleInstallation,
    snapshot: DesktopProjectSnapshot,
  ): Promise<readonly PragmaResource[]> => {
    const project = await options.project.openRevision(snapshot.revision);
    try {
      if (
        !snapshot.resources.some(
          (resource) => canonicalPragmaResourceRef(resource) === installation.rootRef,
        )
      ) {
        throw new BundleInstallationConflictError(
          "installation_root_missing",
          "The imported entry was deleted. Discard this installation or import the bundle again.",
        );
      }
      return project.listResourceClosure(PragmaBundleRootRefSchema.parse(installation.rootRef));
    } finally {
      await project.dispose();
    }
  };

  const evaluateInstallation = async (
    installation: PragmaBundleInstallation,
    snapshot: DesktopProjectSnapshot,
    checkContextContent = true,
    runtimes?: readonly DesktopRuntimeAvailability[],
    scopeRefs?: ReadonlySet<string>,
  ): Promise<{
    readonly readiness: PragmaBundleInstallation["readiness"];
    readonly pending: PragmaBundleInstallation["pending"];
  }> => {
    // Mission admission checks the requested executor, even if a different imported entry was deleted.
    // Explicit recovery still requires the installation's own root to exist.
    let resources =
      scopeRefs !== undefined &&
      !snapshot.resources.some(
        (resource) => canonicalPragmaResourceRef(resource) === installation.rootRef,
      )
        ? snapshot.resources.filter((resource) =>
            installation.resourceRefs.includes(canonicalPragmaResourceRef(resource)),
          )
        : await currentInstallationResources(installation, snapshot);
    const currentRefs = new Set(resources.map(canonicalPragmaResourceRef));
    resources = resources.filter(
      (resource) => scopeRefs === undefined || scopeRefs.has(canonicalPragmaResourceRef(resource)),
    );
    const readiness = await inspectAssetReadiness(resources, {
      capabilities: options.capabilities,
      contextStores: options.contextStores,
      plugins: options.plugins,
      runtimes: runtimes ?? (await options.getRuntimes()),
      checkContextContent,
    });
    const secretReadiness = await Promise.all(
      (installation.readiness.filter((dependency) => dependency.kind === "secret").length > 0
        ? installation.readiness.filter((dependency) => dependency.kind === "secret")
        : installation.pending.filter((dependency) => dependency.kind === "secret")
      )
        .filter(
          (dependency) =>
            currentRefs.has(dependency.resourceRef as PragmaResourceRef) &&
            (scopeRefs === undefined || scopeRefs.has(dependency.resourceRef)),
        )
        .map(async (dependency): Promise<PragmaBundleDependencyReadiness> => {
          const available = await options.plugins.hasSecret(
            `binding:pragma.bundle.${dependency.id}`,
          );
          return {
            ...readinessFromPending(dependency),
            status: available ? "ready" : "missing",
            code: available ? "ready" : "secret_missing",
            action: available ? "none" : "enter_secret",
            message: available ? "Secret is ready." : "Enter the required secret.",
          };
        }),
    );
    const combinedReadiness = mergeReadiness(readiness, secretReadiness);
    const pending = mergePendingMetadata(
      readinessToPending(combinedReadiness),
      installation.pending,
    );
    return { readiness: combinedReadiness, pending };
  };

  const isRecheckableInstallation = (installation: PragmaBundleInstallation): boolean =>
    installation.status === "ready" || installation.status === "needs_setup";

  const recheck = async (
    installation: PragmaBundleInstallation,
  ): Promise<PragmaBundleInstallation> => {
    if (!isRecheckableInstallation(installation)) {
      throw new Error("This bundle installation cannot be rechecked in its current state.");
    }
    const snapshot = await options.project.get();
    const evaluated = await evaluateInstallation(installation, snapshot);
    const updated = await updateInstallation(installation.id, (current) => ({
      ...current,
      projectRevision:
        current.transaction === undefined ? snapshot.revision : current.projectRevision,
      status: evaluated.pending.length === 0 ? "ready" : "needs_setup",
      pending: evaluated.pending,
      readiness: evaluated.readiness,
      error: undefined,
      errorCode: undefined,
      updatedAt: new Date().toISOString(),
    }));
    if (updated.status === "ready") await cleanupInstallationArchive(updated.id);
    return updated;
  };

  const discardCreatedInstallation = async (
    installation: PragmaBundleInstallation,
  ): Promise<void> => {
    const snapshot = await options.project.get();
    const borrowedRoots = installation.conflictResolutions
      .filter((value) => value.action === "keep_local")
      .map(
        (value) =>
          installation.resourceMappings.find((mapping) => mapping.sourceRef === value.resourceRef)
            ?.targetRef ?? value.resourceRef,
      );
    const borrowed = new Set([
      ...borrowedRoots,
      ...borrowedRoots.flatMap((ref) =>
        collectBundleResourceClosure(snapshot.resources, ref).map(canonicalPragmaResourceRef),
      ),
    ]);
    const created = new Set(installation.createdResourceRefs);
    if (
      installation.resourceRefs.some((ref) => !created.has(ref) && !borrowed.has(ref)) ||
      installation.conflictResolutions.some((value) => value.action === "update") ||
      installation.assetConflictResolutions.some((value) => value.action === "update")
    ) {
      throw new Error(
        "This import changed existing project resources. Automatic rollback would overwrite later work, so import it as a copy or restore the project explicitly.",
      );
    }
    const receipt =
      installation.transaction === undefined
        ? undefined
        : await options.project.findRevisionByPublicationId(installation.transaction.publicationId);
    if (installation.projectRevision > 0 || receipt !== undefined) {
      const installed =
        receipt !== undefined && receipt.revision > installation.projectRevision
          ? receipt
          : await options.project.getRevision(installation.projectRevision);
      for (const ref of installation.createdResourceRefs) {
        const expected = installed.resources.find(
          (resource) => canonicalPragmaResourceRef(resource) === ref,
        );
        const current = snapshot.resources.find(
          (resource) => canonicalPragmaResourceRef(resource) === ref,
        );
        if (current !== undefined && stableStringify(expected) !== stableStringify(current))
          throw new Error("An imported resource was edited and cannot be discarded automatically.");
      }
    }
    for (const id of installation.createdCapabilityIds)
      if (
        (await options.capabilities.exists(id)) &&
        (await options.capabilities.get(id)).manifest.latestRevision !== 1
      )
        throw new Error(
          "An imported Capability was revised and cannot be discarded automatically.",
        );
    for (const id of installation.createdContextStoreIds)
      if (
        (await options.contextStores.exists(id)) &&
        (await options.contextStores.get(id)).contentRevision !== 1
      )
        throw new Error(
          "An imported knowledge base was revised and cannot be discarded automatically.",
        );
    const createdRefs = new Set(installation.createdResourceRefs);
    const consumers = (await readCatalog()).installations.filter(
      (candidate) =>
        candidate.id !== installation.id &&
        candidate.projectId === installation.projectId &&
        candidate.resourceRefs.some((ref) => createdRefs.has(ref)),
    );
    if (consumers.length > 0) {
      throw new BundleInstallationConflictError(
        "installation_in_use",
        "Imported resources are reused by another installation and cannot be discarded.",
      );
    }
    const retainedResources = snapshot.resources.filter(
      (resource) => !createdRefs.has(canonicalPragmaResourceRef(resource)),
    );
    if (
      retainedResources.some((resource) =>
        [...referencedPragmaResourceRefs([resource])].some((ref) => createdRefs.has(ref)),
      )
    ) {
      throw new Error(
        "Imported resources are referenced by other project resources and cannot be discarded.",
      );
    }
    const ownedCapabilities = new Set(installation.createdCapabilityIds);
    const ownedContexts = new Set(installation.createdContextStoreIds);
    for (const resource of retainedResources) {
      const capability =
        resource.kind === "Capability"
          ? parseDesktopCapabilityBindingRef(resource.spec.binding ?? "")
          : undefined;
      const context =
        resource.kind === "ContextStore"
          ? parseDesktopContextBindingRef(resource.spec.binding ?? "")
          : undefined;
      if (
        (capability !== undefined && ownedCapabilities.has(capability)) ||
        (context !== undefined && ownedContexts.has(context))
      ) {
        throw new Error(
          "An imported asset is still bound by a retained project resource and cannot be discarded.",
        );
      }
    }
    const retainedArtifactPaths = collectPragmaProjectArtifactPaths(retainedResources);
    if (retainedArtifactPaths.some((path) => path.startsWith(`imports/${installation.id}/`))) {
      throw new Error(
        "Imported files are referenced by retained project resources and cannot be discarded.",
      );
    }
    if (
      createdRefs.size > 0 &&
      snapshot.resources.some((resource) => createdRefs.has(canonicalPragmaResourceRef(resource)))
    ) {
      const artifacts =
        snapshot.revision === 0
          ? new Map<string, string>()
          : await options.project.readArtifacts(snapshot.revision);
      const published = await options.project.publish({
        expectedRevision: snapshot.revision,
        resources: retainedResources,
        artifacts: new Map(
          [...artifacts].filter(
            ([artifactPath]) => !artifactPath.startsWith(`imports/${installation.id}/`),
          ),
        ),
      });
      for (const resource of snapshot.resources) {
        if (resource.kind === "Flow" && createdRefs.has(canonicalPragmaResourceRef(resource))) {
          await options.layouts.remove({
            projectId: published.projectId,
            flowId: resource.metadata.id,
          });
        }
      }
    }
    for (const ref of installation.createdPluginRefs) await options.plugins.remove(ref);
    for (const id of installation.createdContextStoreIds)
      if (await options.contextStores.exists(id)) await options.contextStores.remove(id);
    for (const id of installation.createdCapabilityIds)
      if (await options.capabilities.exists(id)) await options.capabilities.remove(id);
    await removeInstallationRecord(installation.id);
  };

  const bindingRepairPath = (id: string) =>
    join(options.paths.bundleInstallationStateRoot(id), "binding-repair.json");
  const BindingRepairJournalSchema = z
    .object({
      schemaVersion: z.literal("pragma.bundle-binding-repair/v1"),
      publicationId: z.string().uuid(),
      baseRevision: z.number().int().nonnegative(),
      installation: PragmaBundleInstallationSchema,
      upserts: z.array(PragmaForwardCompatibleResourceSchema),
      requiredUnchangedRefs: z.array(PragmaResourceRefSchema),
    })
    .strict();
  const recoverBindingRepair = async (
    id: string,
  ): Promise<PragmaBundleInstallation | undefined> => {
    let journal: z.infer<typeof BindingRepairJournalSchema>;
    try {
      journal = BindingRepairJournalSchema.parse(
        JSON.parse(await readFile(bindingRepairPath(id), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (
      journal.installation.id !== id ||
      journal.installation.projectId !== options.project.projectId
    )
      throw new Error("The binding repair journal belongs to a different installation.");
    const published =
      (await options.project.findRevisionByPublicationId(journal.publicationId)) ??
      (await options.project.applyTransactional(
        {
          baseRevision: journal.baseRevision,
          upserts: journal.upserts,
          requiredUnchangedRefs: journal.requiredUnchangedRefs,
        },
        journal.publicationId,
      ));
    // A rebind can make two previously distinct resources equivalent. Resolve ownership
    // against the actual publication receipt, including recovery after a lost receipt.
    const base = await options.project.getRevision(journal.baseRevision);
    const candidates = new Map(
      [...base.resources, ...journal.upserts].map((resource) => [
        canonicalPragmaResourceRef(resource),
        resource,
      ]),
    );
    const publishedRefs = new Set(published.resources.map(canonicalPragmaResourceRef));
    const mapRef = (ref: string) => {
      if (publishedRefs.has(ref)) return ref;
      const candidate = candidates.get(ref);
      const binding =
        candidate === undefined ? undefined : classifyHostCapabilityResource(candidate);
      const canonical =
        binding === undefined
          ? undefined
          : published.resources.find(
              (resource) => classifyHostCapabilityResource(resource)?.id === binding.id,
            );
      return canonical === undefined ? ref : canonicalPragmaResourceRef(canonical);
    };
    const owned = new Set(journal.installation.createdResourceRefs);
    const baseRefs = new Set(base.resources.map(canonicalPragmaResourceRef));
    const installation = await updateInstallation(id, () =>
      PragmaBundleInstallationSchema.parse({
        ...journal.installation,
        rootRef: mapRef(journal.installation.rootRef),
        resourceRefs: unique(journal.installation.resourceRefs.map(mapRef)),
        createdResourceRefs: unique(journal.installation.createdResourceRefs.map(mapRef)).filter(
          (ref) => !baseRefs.has(ref) || owned.has(ref),
        ),
        resourceMappings: journal.installation.resourceMappings.map((mapping) => ({
          ...mapping,
          targetRef: mapRef(mapping.targetRef),
        })),
        pending: journal.installation.pending.map((entry) => ({
          ...entry,
          resourceRef: mapRef(entry.resourceRef),
        })),
        readiness: journal.installation.readiness.map((entry) => ({
          ...entry,
          resourceRef: mapRef(entry.resourceRef),
        })),
        projectRevision: published.revision,
      }),
    );
    const result = await recheck(installation);
    await rm(bindingRepairPath(id), { force: true });
    return result;
  };
  const resolveInstallationBindings = async (
    input: ResolvePragmaBundleInstallation,
    context: {
      installation: PragmaBundleInstallation;
      snapshot: DesktopProjectSnapshot;
      localized: ReturnType<typeof remapPragmaResourceIdentities>;
      selected: ReadonlySet<string>;
    },
  ): Promise<PragmaBundleInstallation> => {
    const { installation, snapshot } = context;
    if (installation.projectId !== options.project.projectId)
      throw new Error("This installation belongs to another project.");
    if (snapshot.revision !== input.baseRevision) {
      throw new Error("The project changed. Reload bundle setup before saving.");
    }
    const pendingFor = (kind: string, resourceRef: string) =>
      installation.pending.find(
        (dependency) =>
          dependency.kind === kind &&
          (dependency.resourceRef === resourceRef ||
            context.localized.resourceMappings.get(dependency.resourceRef as PragmaResourceRef) ===
              resourceRef),
      );
    const requireImportedResource = (
      kind: "runtime" | "capability" | "context-store",
      resourceRef: PragmaResourceRef,
    ): PragmaResource => {
      const resource = context.localized.resources.find(
        (candidate) => canonicalPragmaResourceRef(candidate) === resourceRef,
      );
      if (resource === undefined) {
        throw new Error(`Imported ${kind} resource no longer exists: ${resourceRef}`);
      }
      return resource;
    };
    assertUniqueResolutionRefs(input.runtimes, "Runtime");
    assertUniqueResolutionRefs(input.capabilities, "capability");
    assertUniqueResolutionRefs(input.contextStores, "knowledge-base");
    const replacements = new Map<PragmaResourceRef, PragmaResource>();
    const runtimes = await options.getRuntimes();
    for (const resolution of input.runtimes) {
      const resource = requireImportedResource("runtime", resolution.resourceRef);
      if (resource.kind !== "RuntimeProfile") {
        throw new Error(`${resolution.resourceRef} is not a Runtime profile.`);
      }
      if (
        !runtimes.some((runtime) =>
          runtimeDependencyAvailable(runtime, {
            resourceRef: resolution.resourceRef,
            name: resource.metadata.name,
            runtimeId: resolution.runtimeId,
            providerId: resolution.providerId,
            modelId: resolution.modelId,
            thinkingLevel: resolution.thinkingLevel,
          }),
        )
      ) {
        throw new Error("The selected Runtime, model, or thinking level is unavailable.");
      }
      replacements.set(
        resolution.resourceRef,
        PragmaForwardCompatibleResourceSchema.parse({
          ...resource,
          spec: {
            ...resource.spec,
            config: rebindRuntimeConfig(resource.spec.config, resolution),
          },
        }),
      );
    }
    for (const resolution of input.capabilities) {
      const resource = requireImportedResource("capability", resolution.resourceRef);
      if (resource.kind !== "Capability") {
        throw new Error(`${resolution.resourceRef} is not a capability resource.`);
      }
      const capability = await resolveCapabilityForBinding(
        options.capabilities,
        resolution.capabilityId,
      );
      const availableTools = new Set(capabilityToolNames(capability));
      for (const expert of context.localized.resources) {
        if (expert.kind !== "Expert") continue;
        for (const reference of expert.spec.capabilities) {
          if (reference.ref !== resolution.resourceRef) continue;
          if (
            (reference.kind === "skill") !== (capability.definition.kind === "skill") ||
            (reference.kind === "tools" &&
              (reference.tools ?? []).some((tool) => !availableTools.has(tool)))
          )
            throw new CapabilityStoreError(
              "capability_incompatible",
              `The selected capability cannot satisfy ${expert.metadata.name}'s declared tools or Skill requirements.`,
            );
        }
      }

      const requiredKind = pendingFor("capability", resolution.resourceRef)?.capabilityKind;
      if (requiredKind !== undefined && capability.definition.kind !== requiredKind) {
        throw new Error(`Choose a ${requiredKind} capability for ${resource.metadata.name}.`);
      }
      replacements.set(
        resolution.resourceRef,
        bindExistingDesktopCapabilityResource(resource, {
          id: resolution.capabilityId,
        }),
      );
    }
    for (const resolution of input.contextStores) {
      const resource = requireImportedResource("context-store", resolution.resourceRef);
      if (resource.kind !== "ContextStore") {
        throw new Error(`${resolution.resourceRef} is not a knowledge-base resource.`);
      }
      const store = await options.contextStores.resolve(resolution.storeId);
      replacements.set(
        resolution.resourceRef,
        bindExistingDesktopContextResource(resource, resolution.storeId, {
          name: store.name,
          description: resource.metadata.description,
        }),
      );
    }
    if (Object.keys(input.secrets).length > 0) {
      const allowedSecrets = new Set(
        installation.pending.flatMap((dependency) =>
          dependency.kind === "secret" ? [dependency.id] : [],
        ),
      );
      for (const binding of Object.keys(input.secrets)) {
        if (!allowedSecrets.has(binding)) {
          throw new Error(`Secret is not requested by this bundle installation: ${binding}`);
        }
      }
      await options.plugins.setSecrets(
        Object.fromEntries(
          Object.entries(input.secrets).map(([requirementId, value]) => [
            `binding:pragma.bundle.${requirementId}`,
            value,
          ]),
        ),
      );
    }
    const updated = PragmaBundleInstallationSchema.parse(
      ((record) => ({
        ...record,
        rootRef: context.localized.resourceMappings.get(record.rootRef) ?? record.rootRef,
        ...(record.knowledgeBaseUpdate === undefined
          ? {}
          : {
              knowledgeBaseUpdate: {
                ...record.knowledgeBaseUpdate,
                targetRef:
                  context.localized.resourceMappings.get(record.knowledgeBaseUpdate.targetRef) ??
                  record.knowledgeBaseUpdate.targetRef,
              },
            }),
        rootName:
          context.localized.resources.find(
            (resource) =>
              canonicalPragmaResourceRef(resource) ===
              (context.localized.resourceMappings.get(record.rootRef) ?? record.rootRef),
          )?.metadata.name ?? record.rootName,
        resourceRefs: unique([
          ...record.resourceRefs.map((ref) => context.localized.resourceMappings.get(ref) ?? ref),
          ...context.localized.resources.map(canonicalPragmaResourceRef),
        ]),
        createdResourceRefs: unique([
          ...record.createdResourceRefs.map(
            (ref) => context.localized.resourceMappings.get(ref) ?? ref,
          ),
          ...[...context.localized.resourceMappings]
            .filter(([source, target]) => source !== target)
            .map(([, target]) => target),
        ]),
        pending: record.pending.map((value) => ({
          ...value,
          resourceRef:
            context.localized.resourceMappings.get(value.resourceRef as PragmaResourceRef) ??
            value.resourceRef,
        })),
        readiness: record.readiness.map((value) => ({
          ...value,
          resourceRef:
            context.localized.resourceMappings.get(value.resourceRef as PragmaResourceRef) ??
            value.resourceRef,
        })),
        resourceMappings: record.resourceMappings.map((value) => ({
          ...value,
          targetRef: context.localized.resourceMappings.get(value.targetRef) ?? value.targetRef,
        })),
      }))(installation),
    );

    const upserts = context.localized.resources
      .filter((resource) => {
        const ref = canonicalPragmaResourceRef(resource);
        const original = snapshot.resources.find(
          (value) => canonicalPragmaResourceRef(value) === ref,
        );
        return (
          original === undefined ||
          stableStringify(original) !== stableStringify(resource) ||
          replacements.has(ref)
        );
      })
      .map((resource) => replacements.get(canonicalPragmaResourceRef(resource)) ?? resource);
    if (upserts.length === 0) return await recheck(updated);
    const journal = BindingRepairJournalSchema.parse({
      schemaVersion: "pragma.bundle-binding-repair/v1",
      publicationId: randomUUID(),
      baseRevision: snapshot.revision,
      installation: updated,
      upserts,
      requiredUnchangedRefs: [...context.selected],
    });
    await writeBundleAtomically(
      bindingRepairPath(installation.id),
      new TextEncoder().encode(JSON.stringify(journal)),
    );
    return (await recoverBindingRepair(installation.id))!;
  };
  const describeCapabilityChoices = async (
    requirements: PragmaBundleImportInspection["requirements"],
    resources: readonly PragmaResource[],
  ) => {
    if (!requirements.some((value) => value.kind === "capability")) return;
    const capabilities = await Promise.all(
      (await options.capabilities.list()).map(async (value) => {
        try {
          return await resolveCapabilityForBinding(options.capabilities, value.manifest.id);
        } catch {
          return undefined;
        }
      }),
    );
    for (const requirement of requirements) {
      if (requirement.kind !== "capability") continue;
      const references = resources.flatMap((resource) =>
        resource.kind === "Expert"
          ? resource.spec.capabilities.filter(
              (reference) => reference.ref === requirement.resourceRef,
            )
          : [],
      );
      const requiredTools = unique(
        references.flatMap((reference) =>
          reference.kind === "tools" ? (reference.tools ?? []) : [],
        ),
      );
      requirement.requiredTools = requiredTools;
      requirement.compatibleCapabilityIds = capabilities
        .filter(
          (value) =>
            value !== undefined &&
            value.health.status === "ready" &&
            (requirement.capabilityKind === undefined ||
              value.definition.kind === requirement.capabilityKind) &&
            references.every(
              (reference) => (reference.kind === "skill") === (value.definition.kind === "skill"),
            ) &&
            requiredTools.every((tool) => capabilityToolNames(value).includes(tool)),
        )
        .map((value) => value!.manifest.id);
    }
  };

  const service: PragmaBundleService = {
    async initialize() {
      await ensureInitialized();
    },

    async suggestExportFilename(input) {
      const snapshot = await options.project.get();
      if (snapshot.revision !== input.projectRevision) {
        throw new Error(
          `Project revision changed from ${input.projectRevision} to ${snapshot.revision}. Reopen the export dialog.`,
        );
      }
      const root = snapshot.resources.find(
        (resource) => canonicalPragmaResourceRef(resource) === input.rootRef,
      );
      if (
        root === undefined ||
        (root.kind !== "Expert" &&
          root.kind !== "ExpertTeam" &&
          root.kind !== "Flow" &&
          root.kind !== "ContextStore" &&
          root.kind !== "Capability")
      ) {
        throw new Error(`Bundle root not found: ${input.rootRef}`);
      }
      return `${root.metadata.name}.pragma`;
    },

    async prepareExport(input) {
      const prepared = await prepare(input.rootRef, input.projectRevision);
      try {
        const flowLayouts = await Promise.all(
          prepared.flows.map(
            async (flow) =>
              await options.layouts.get({
                projectId: prepared.snapshot.projectId,
                flowId: flow.metadata.id,
              }),
          ),
        );
        return PragmaBundleExportPreviewSchema.parse({
          root: {
            ref: canonicalPragmaResourceRef(prepared.root),
            kind: prepared.root.kind,
            name: prepared.root.metadata.name,
            description: prepared.root.metadata.description,
            tags: prepared.root.metadata.tags,
            ...(prepared.root.kind === "Expert" || prepared.root.kind === "ExpertTeam"
              ? { avatarId: prepared.root.metadata.avatarId }
              : {}),
            ...(prepared.root.kind === "Capability"
              ? {
                  activeRevision: prepared.capabilities.find(
                    (entry) => canonicalPragmaResourceRef(entry.resource) === input.rootRef,
                  )?.capability?.manifest.latestRevision,
                }
              : {}),
          },
          projectRevision: prepared.snapshot.revision,
          resourceCount: prepared.resources.length,
          capabilityCount: prepared.capabilities.length,
          pluginCount: 0,
          knowledgeBaseCount: prepared.contexts.length,
          hasFlowLayouts: flowLayouts.some((layout) => layout !== null),
          defaults: {
            capabilities: true,
            plugins: false,
            knowledgeBases: false,
            flowLayouts: flowLayouts.some((layout) => layout !== null),
          },
        });
      } finally {
        await prepared.dispose();
      }
    },

    async exportTo(input, destinationPath) {
      if (input.modules.plugins) {
        throw new BundlePluginUnavailableError("export");
      }
      const prepared = await prepare(input.rootRef, input.projectRevision);
      try {
        const includeKnowledgeBases =
          prepared.root.kind === "ContextStore" || input.modules.knowledgeBases;
        const resourcesByRef = new Map(
          prepared.resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
        );
        const capabilityByRef = new Map(
          prepared.capabilities.map((entry) => [canonicalPragmaResourceRef(entry.resource), entry]),
        );
        const contextByRef = new Map(
          prepared.contexts.map((entry) => [canonicalPragmaResourceRef(entry.resource), entry]),
        );
        const extensions = [];
        if (input.modules.flowLayouts) {
          const layoutFiles = new Map<string, Uint8Array>();
          for (const flow of prepared.flows) {
            const layout = await options.layouts.get({
              projectId: prepared.snapshot.projectId,
              flowId: flow.metadata.id,
            });
            if (layout !== null) {
              layoutFiles.set(
                `${flow.metadata.id}.json`,
                new TextEncoder().encode(`${JSON.stringify(layout, null, 2)}\n`),
              );
            }
          }
          if (layoutFiles.size > 0) {
            extensions.push({
              id: "pragma.desktop.flow-layout",
              version: "v1",
              required: false,
              files: layoutFiles,
            });
          }
        }
        const exported = await prepared.project.exportBundle({
          roots: [canonicalPragmaResourceRef(prepared.root)],
          extensions,
          host: {
            exportPayload: async ({ requirement, originalBindingRef }) => {
              if (requirement.kind === "binding") {
                const resource = resourcesByRef.get(requirement.ownerRef);
                if (
                  resource?.kind === "Capability" &&
                  (input.modules.capabilities || prepared.root.kind === "Capability")
                ) {
                  const entry = capabilityByRef.get(requirement.ownerRef);
                  if (entry?.capability === undefined || originalBindingRef === undefined) {
                    return undefined;
                  }
                  if (!isPortableValue(entry.capability.definition)) return undefined;
                  const sourceRevision = entry.capability.manifest.latestRevision;
                  const sourceDefinition = entry.capability.definition;
                  const files = new Map<string, Uint8Array>([
                    [
                      "descriptor.json",
                      new TextEncoder().encode(
                        `${JSON.stringify(
                          {
                            schemaVersion: "pragma.desktop.capability-descriptor/v3",
                            assetKey: entry.capability.manifest.id,
                            definition: sourceDefinition,
                            fingerprint: sha256(stableStringify(sourceDefinition)),
                          },
                          null,
                          2,
                        )}\n`,
                      ),
                    ],
                  ]);
                  if (sourceDefinition.kind === "skill") {
                    const skillFilesPath = await options.capabilities.skillFilesPath(
                      entry.capability.manifest.id,
                      sourceRevision,
                    );
                    const skillSnapshot = await scanSkillWorkingTree(skillFilesPath);
                    if (
                      !(await portableSkillDirectoryContentHashes(skillFilesPath)).has(
                        sourceDefinition.contentHash,
                      )
                    ) {
                      throw new Error(
                        `Skill ${entry.capability.manifest.id} revision ${sourceRevision} content hash does not match its files.`,
                      );
                    }
                    const payload = await readTransferredSkill(
                      skillFilesPath,
                      sourceDefinition.executablePaths,
                    );
                    for (const file of payload.files)
                      files.set(`files/${file.path}`, Buffer.from(file.content, "base64"));
                    const descriptor = SkillBundlePayloadDescriptorSchema.parse({
                      schemaVersion: "pragma.skill-bundle-payload/v1",
                      assetKey: entry.capability.manifest.id,
                      name: sourceDefinition.name,
                      description: sourceDefinition.description,
                      entryPath: sourceDefinition.entryPath,
                      contentHash: sourceDefinition.contentHash,
                      filesFingerprint: sha256(
                        serializeSkillBundleFileManifest(skillSnapshot.entries),
                      ),
                      fingerprint: sha256(serializeSkillBundleDefinition(sourceDefinition)),
                      files: skillSnapshot.entries,
                    });
                    files.set(
                      "descriptor.json",
                      new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`),
                    );
                    assertValidSkillBundlePayload({
                      descriptor,
                      files,
                      sha256,
                      label: `${entry.capability.manifest.id}@${sourceRevision}`,
                    });
                    return { codec: "pragma.skill@v1", files };
                  }
                  return { codec: "pragma.desktop.capability@v3", files };
                }
                if (resource?.kind === "ContextStore") {
                  const entry = contextByRef.get(requirement.ownerRef);
                  if (entry?.store === undefined || originalBindingRef === undefined)
                    return undefined;
                  const [snapshot, fingerprint] = await Promise.all([
                    includeKnowledgeBases
                      ? readTransferredKnowledge(options.contextStores, entry.store.id).then(
                          (payload) => payload.snapshot,
                        )
                      : Promise.resolve(undefined),
                    options.contextStores.fingerprint(entry.store.id),
                  ]);
                  const files = new Map<string, Uint8Array>([
                    [
                      "descriptor.json",
                      new TextEncoder().encode(
                        `${JSON.stringify(
                          {
                            schemaVersion: "pragma.desktop.context-store-descriptor/v4",
                            name: entry.store.name,
                            description: entry.store.description,
                            fingerprint,
                            contentIncluded: includeKnowledgeBases,
                            ...(snapshot === undefined
                              ? {}
                              : {
                                  snapshot: {
                                    ...snapshot,
                                    files: snapshot.files.map(({ id, metadata }) => ({
                                      id,
                                      metadata,
                                    })),
                                  },
                                }),
                          },
                          null,
                          2,
                        )}\n`,
                      ),
                    ],
                  ]);
                  for (const file of snapshot?.files ?? []) {
                    files.set(`files/${file.id}`, new TextEncoder().encode(file.content));
                  }
                  return { codec: "pragma.desktop.context-store@v4", files };
                }
                return undefined;
              }
              return undefined;
            },
          },
        });
        await writeBundleAtomically(destinationPath, exported.bytes);
        return PragmaBundleExportResultSchema.parse({
          cancelled: false,
          path: destinationPath,
          bundleFingerprint: exported.manifest.bundleFingerprint,
          projectFingerprint: exported.manifest.project.projectFingerprint,
        }) as {
          readonly path: string;
          readonly bundleFingerprint: string;
          readonly projectFingerprint: string;
        };
      } catch (error) {
        throwBundleExportValidationError(error);
      } finally {
        await prepared.dispose();
      }
    },

    async inspect(sourcePath, rootRef, decisions) {
      const archive = await readDesktopBundle(sourcePath, rootRef);
      assertBundleHasNoPlugins(archive);
      const current = await options.project.get();
      const conflicts = findBundleConflicts(
        archive.resources.filter((resource) => !isPragmaManagementCapability(resource)),
        current.resources,
      );
      const [capabilities, contextStores, plugins, runtimes] = await Promise.all([
        options.capabilities.list(),
        options.contextStores.list(),
        options.plugins.list(),
        options.getRuntimes(),
      ]);
      const contextFingerprints = new Map(
        await Promise.all(
          contextStores.map(
            async (store) => [store.id, await options.contextStores.fingerprint(store.id)] as const,
          ),
        ),
      );
      const boundCapabilityRefs = new Map<string, PragmaResourceRef>();
      const boundContextRefs = new Map<string, PragmaResourceRef>();
      for (const resource of current.resources) {
        if (resource.kind === "Capability") {
          const binding = parseDesktopCapabilityBindingRef(resource.spec.binding ?? "");
          if (binding !== undefined && !boundCapabilityRefs.has(binding)) {
            boundCapabilityRefs.set(binding, canonicalPragmaResourceRef(resource));
          }
        } else if (resource.kind === "ContextStore") {
          const storeId = parseDesktopContextBindingRef(resource.spec.binding ?? "");
          if (storeId !== undefined && !boundContextRefs.has(storeId)) {
            boundContextRefs.set(storeId, canonicalPragmaResourceRef(resource));
          }
        }
      }
      const importedSkillAssets = new Map<
        string,
        {
          readonly resourceRef: PragmaResourceRef;
          readonly assetKind: "skill";
          readonly name: string;
          readonly fingerprint: string;
          readonly fingerprintKind: "asset" | "definition";
        }
      >();
      for (const dependency of archive.manifest.dependencies.capabilities) {
        if (
          !dependency.included ||
          dependency.kind !== "skill" ||
          dependency.definitionFingerprint === undefined
        ) {
          continue;
        }
        const key = bundleCapabilityAssetKey(dependency);
        if (!importedSkillAssets.has(key)) {
          importedSkillAssets.set(key, {
            resourceRef: PragmaResourceRefSchema.parse(dependency.resourceRef),
            assetKind: "skill",
            name: dependency.name,
            fingerprint: dependency.assetFingerprint ?? dependency.definitionFingerprint,
            fingerprintKind: dependency.assetFingerprint === undefined ? "definition" : "asset",
          });
        }
      }
      const localSkillAssets = await Promise.all(
        capabilities
          .filter(
            (capability) =>
              capability.definition.kind === "skill" && capability.managedBy !== "system",
          )
          .map(async (capability) => {
            const definitionFingerprint = sha256(stableStringify(capability.definition));
            const requiresAssetFingerprint = [...importedSkillAssets.values()].some(
              (asset) =>
                asset.fingerprintKind === "asset" &&
                normalizePragmaResourceName(asset.name) ===
                  normalizePragmaResourceName(capability.definition.name),
            );
            return {
              assetId: capability.manifest.id,
              assetKind: "skill" as const,
              name: capability.definition.name,
              revision: capability.manifest.latestRevision,
              fingerprint: requiresAssetFingerprint
                ? await localSkillAssetFingerprint(capability)
                : definitionFingerprint,
              definitionFingerprint,
              boundResourceRef: boundCapabilityRefs.get(capability.manifest.id),
            };
          }),
      );
      const assetConflicts = findBundleAssetConflicts(
        [
          ...importedSkillAssets.values(),
          ...archive.manifest.dependencies.contextStores.flatMap((dependency) =>
            dependency.included && dependency.fingerprint !== undefined
              ? [
                  {
                    resourceRef: PragmaResourceRefSchema.parse(dependency.resourceRef),
                    assetKind: "knowledge_base" as const,
                    name: dependency.name,
                    fingerprint: knowledgeBaseAssetFingerprint({
                      name: dependency.name,
                      description: dependency.description,
                      snapshotHash: dependency.snapshot?.snapshotHash ?? dependency.fingerprint,
                    }),
                  },
                ]
              : [],
          ),
        ],
        [
          ...localSkillAssets,
          ...contextStores.map((store) => ({
            assetId: store.id,
            assetKind: "knowledge_base" as const,
            name: store.name,
            revision: store.contentRevision,
            fingerprint: knowledgeBaseAssetFingerprint({
              name: store.name,
              description: store.description,
              snapshotHash: store.snapshotHash,
            }),
            boundResourceRef: boundContextRefs.get(store.id),
          })),
        ],
      );
      const inspectedConflicts = await Promise.all(
        conflicts.map(async (conflict) => {
          if (conflict.resourceKind !== "ContextStore" || !conflict.updateAllowed) return conflict;
          const localRef = conflict.matches[0]?.localRef;
          const localResource = current.resources.find(
            (resource) => canonicalPragmaResourceRef(resource) === localRef,
          );
          if (localResource?.kind !== "ContextStore") return conflict;
          const storeId = parseDesktopContextBindingRef(localResource.spec.binding ?? "");
          if (storeId === undefined || !contextStores.some((store) => store.id === storeId)) {
            return {
              ...conflict,
              updateAllowed: false,
              updateBlockedReason:
                "The matched knowledge base is not bound to an available managed Store.",
            };
          }
          const snapshot = await options.contextStores.getSnapshot(storeId);
          return {
            ...conflict,
            targetRevision: snapshot.revision,
            targetSnapshotHash: snapshot.snapshotHash,
          };
        }),
      );
      let plan: ReturnType<typeof planBundleResources> | undefined;
      if (decisions !== undefined) {
        const identities = resolveBundleIdentities(
          archive.resources.filter((resource) => !isPragmaManagementCapability(resource)),
          current.resources,
          decisions.conflicts,
        ).identities;
        const localized = localizePragmaBundleResources({
          resources: archive.resources,
          manifest: archive.bundle.manifest,
          identities,
        });
        plan = planBundleResources({
          imported: localized.resources,
          current: current.resources,
          rootRef:
            localized.resourceMappings.get(archive.manifest.root.ref) ?? archive.manifest.root.ref,
          mappings: localized.resourceMappings,
          conflicts: decisions.conflicts,
        });
      }
      const requirements: PragmaBundleImportInspection["requirements"] = [];
      const ambiguousRequirements = new Set<string>();
      for (const dependency of archive.manifest.dependencies.capabilities) {
        if (dependency.resourceRef === PRAGMA_MANAGEMENT_CAPABILITY_REF) continue;
        const exact =
          dependency.definitionFingerprint === undefined
            ? undefined
            : uniqueMatch(
                capabilities,
                (candidate) =>
                  sha256(stableStringify(candidate.definition)) ===
                  dependency.definitionFingerprint,
              );
        const candidates = capabilities.filter((candidate) =>
          dependency.definitionFingerprint === undefined
            ? dependency.kind === undefined || candidate.definition.kind === dependency.kind
            : sha256(stableStringify(candidate.definition)) === dependency.definitionFingerprint,
        );
        if (!dependency.included && candidates.length > 1)
          ambiguousRequirements.add(dependency.requirementId);
        if (exact === undefined && !dependency.included) {
          requirements.push({
            id: dependency.requirementId,
            kind: "capability",
            resourceRef: dependency.resourceRef,
            name: dependency.name,
            message: "Choose an existing compatible capability.",
            required: true,
            ...(dependency.kind === undefined ? {} : { capabilityKind: dependency.kind }),
          });
        }
      }
      for (const dependency of archive.manifest.dependencies.contextStores) {
        const exact =
          dependency.fingerprint === undefined
            ? undefined
            : uniqueMatch(
                contextStores,
                (store) => contextFingerprints.get(store.id) === dependency.fingerprint,
              );
        if (
          !dependency.included &&
          dependency.fingerprint !== undefined &&
          contextStores.filter(
            (store) => contextFingerprints.get(store.id) === dependency.fingerprint,
          ).length > 1
        )
          ambiguousRequirements.add(dependency.requirementId);
        if (exact === undefined && !dependency.included) {
          requirements.push({
            id: dependency.requirementId,
            kind: "context-store",
            resourceRef: dependency.resourceRef,
            name: dependency.name,
            message: "Choose an existing knowledge base now, or set it up after import.",
            required: false,
          });
        }
      }
      for (const dependency of archive.manifest.dependencies.plugins) {
        const exact = plugins.find((plugin) => plugin.ref === dependency.ref);
        if (exact === undefined && !dependency.included) {
          requirements.push({
            id: dependency.requirementId,
            kind: "plugin",
            resourceRef: dependency.ref,
            name: dependency.name,
            message: "Install the exact plugin package after importing this Bundle.",
            required: false,
          });
        }
      }
      for (const dependency of archive.manifest.dependencies.runtimes) {
        if (runtimes.filter((runtime) => runtime.id === dependency.runtimeId).length > 1)
          ambiguousRequirements.add(dependency.requirementId);
        if (
          !ambiguousRequirements.has(dependency.requirementId) &&
          runtimes.some((runtime) => runtimeDependencyAvailable(runtime, dependency))
        )
          continue;
        requirements.push({
          id: dependency.requirementId,
          kind: "runtime",
          resourceRef: dependency.resourceRef,
          name: dependency.name,
          message: "Choose a compatible local Runtime and model.",
          required: true,
          runtimeRequest: {
            ...(dependency.runtimeId === undefined ? {} : { runtimeId: dependency.runtimeId }),
            ...(dependency.providerId === undefined ? {} : { providerId: dependency.providerId }),
            ...(dependency.modelId === undefined ? {} : { modelId: dependency.modelId }),
            ...(dependency.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: dependency.thinkingLevel }),
          },
        });
      }
      for (const secret of archive.manifest.dependencies.secrets) {
        const binding = `binding:pragma.bundle.${secret.id}`;
        if (await options.plugins.hasSecret(binding)) continue;
        requirements.push({
          id: secret.id,
          kind: "secret",
          resourceRef: secret.ownerRef,
          name:
            typeof secret.hints["secretName"] === "string"
              ? secret.hints["secretName"]
              : secret.name,
          message: `Enter the secret for ${secret.name}.`,
          required: true,
        });
      }
      for (const dependency of archive.manifest.dependencies.unsupported) {
        if (!dependency.required) continue;
        requirements.push({
          id: dependency.id,
          kind: "plugin",
          resourceRef: dependency.ownerRef,
          name: dependency.name,
          message: `This Host does not support required Bundle dependency ${dependency.contract}.`,
          required: true,
        });
      }
      if (plan !== undefined) {
        for (let index = requirements.length - 1; index >= 0; index--) {
          if (!plan.sourceRefs.has(requirements[index]!.resourceRef as PragmaResourceRef))
            requirements.splice(index, 1);
        }
      }
      const installations = (await readCatalog()).installations;
      const incompleteInstallation = findIncompleteInstallation(
        installations,
        archive.manifest.bundleFingerprint,
        archive.manifest.root.ref,
      );
      for (const requirement of requirements)
        if (ambiguousRequirements.has(requirement.id))
          requirement.message =
            "Multiple local dependencies are candidates for this requirement. Choose an explicit binding.";
      const readiness = buildInspectionReadiness(archive, requirements).map((dependency) =>
        ambiguousRequirements.has(dependency.id)
          ? { ...dependency, status: "action_required" as const, code: "binding_ambiguous" }
          : dependency,
      );
      if (plan !== undefined) {
        const writable = new Set(plan.resources.map(canonicalPragmaResourceRef));
        const retained = await inspectAssetReadiness(
          plan.effective.filter((resource) => !writable.has(canonicalPragmaResourceRef(resource))),
          {
            capabilities: options.capabilities,
            contextStores: options.contextStores,
            plugins: options.plugins,
            runtimes,
          },
        );
        readiness.splice(
          0,
          readiness.length,
          ...readiness.filter((value) =>
            plan.sourceRefs.has(value.resourceRef as PragmaResourceRef),
          ),
          ...retained,
        );
      }
      await describeCapabilityChoices(
        requirements,
        plan === undefined
          ? archive.resources
          : archive.resources.filter((resource) =>
              plan.sourceRefs.has(canonicalPragmaResourceRef(resource)),
            ),
      );
      return PragmaBundleImportInspectionSchema.parse({
        sourcePath,
        sourceName: basename(sourcePath),
        bundleFingerprint: archive.manifest.bundleFingerprint,
        projectFingerprint: archive.manifest.projectFingerprint,
        projectRevision: current.revision,
        root: archive.manifest.root,
        roots: archive.manifest.roots,
        createdAt: archive.manifest.createdAt,
        archiveBytes: archive.archiveBytes,
        unpackedBytes: archive.unpackedBytes,
        fileCount: archive.fileCount,
        resources: archive.resources.length,
        resourceDetails: archive.resources.map((resource) => ({
          ref: canonicalPragmaResourceRef(resource),
          kind: resource.kind,
          name: resource.metadata.name,
        })),
        runtimeModels: {
          ...bundleRuntimeModels(plan?.effective ?? archive.resources),
          ...bundleRuntimeModels(
            plan === undefined
              ? archive.resources
              : archive.resources.filter((resource) =>
                  plan.sourceRefs.has(canonicalPragmaResourceRef(resource)),
                ),
          ),
        },
        dependencies: [
          ...archive.manifest.dependencies.runtimes.map((item) => ({
            kind: "runtime" as const,
            ref: item.resourceRef,
            name: item.name,
            included: false,
          })),
          ...archive.manifest.dependencies.capabilities.map((item) => ({
            kind: "capability" as const,
            ref: item.resourceRef,
            name: item.name,
            included: item.included,
          })),
          ...archive.manifest.dependencies.contextStores.map((item) => ({
            kind: "context-store" as const,
            ref: item.resourceRef,
            name: item.name,
            included: item.included,
          })),
          ...archive.manifest.dependencies.plugins.map((item) => ({
            kind: "plugin" as const,
            ref: item.ref,
            name: item.name,
            included: item.included,
          })),
        ],
        conflicts: inspectedConflicts,
        assetConflicts,
        requirements,
        readiness,
        sameContentInstallationIds: installations.flatMap((installation) =>
          installation.sourceProjectFingerprint === archive.manifest.projectFingerprint &&
          installation.sourceRootRef === archive.manifest.root.ref &&
          installation.id !== incompleteInstallation?.id
            ? [installation.id]
            : [],
        ),
        ...(incompleteInstallation === undefined
          ? {}
          : { alreadyInstalledId: incompleteInstallation.id }),
      });
    },

    async inspectInstallation(installationId) {
      const installation = (await readCatalog()).installations.find(
        (value) => value.id === installationId && value.projectId === options.project.projectId,
      );
      if (installation === undefined) throw new Error("Bundle installation not found.");
      const snapshot = await options.project.get();
      const root = {
        ref: installation.sourceRootRef,
        kind: installation.rootKind,
        name: installation.rootName,
      };
      const requirements: PragmaBundleImportInspection["requirements"] = installation.pending.map(
        (dependency) => {
          const resource = snapshot.resources.find(
            (value) => canonicalPragmaResourceRef(value) === dependency.resourceRef,
          );
          const config =
            resource?.kind === "RuntimeProfile"
              ? (resource.spec.config as Record<string, unknown>)
              : undefined;
          return {
            id: dependency.id,
            kind: dependency.kind,
            resourceRef: dependency.resourceRef,
            name: dependency.name,
            message: dependency.message,
            required: dependency.kind !== "context-store" && dependency.kind !== "plugin",
            ...(dependency.capabilityKind === undefined
              ? {}
              : { capabilityKind: dependency.capabilityKind }),
            ...(config === undefined
              ? {}
              : {
                  runtimeRequest: {
                    ...(typeof config.runtimeId === "string"
                      ? { runtimeId: config.runtimeId }
                      : {}),
                    ...(typeof config.providerId === "string"
                      ? { providerId: config.providerId }
                      : {}),
                    ...(typeof config.model === "string" ? { modelId: config.model } : {}),
                  },
                }),
          };
        },
      );
      await describeCapabilityChoices(requirements, snapshot.resources);
      return PragmaBundleImportInspectionSchema.parse({
        sourcePath: options.paths.bundleInstallationArchive(installation.id),
        sourceName: installation.rootName,
        bundleFingerprint: installation.bundleFingerprint,
        projectFingerprint: installation.sourceProjectFingerprint ?? installation.bundleFingerprint,
        projectRevision: snapshot.revision,
        root,
        roots: [root],
        createdAt: installation.createdAt,
        resources: installation.resourceRefs.length,
        runtimeModels: bundleRuntimeModels(
          collectBundleResourceClosure(snapshot.resources, installation.rootRef),
        ),
        dependencies: [],
        conflicts: [],
        assetConflicts: [],
        requirements,
        readiness: installation.readiness,
        sameContentInstallationIds: [],
        alreadyInstalledId: installation.id,
      });
    },

    async startImport(input) {
      input = StartPragmaBundleImportSchema.parse({
        ...input,
        requestId: input.requestId ?? randomUUID(),
      });
      return await withFileLock(
        options.paths.bundleImportLock(input.requestId ?? input.expectedFingerprint),
        async () => {
          const known =
            input.requestId === undefined
              ? undefined
              : (await readCatalog()).installations.find(
                  (record) =>
                    record.projectId === options.project.projectId &&
                    record.transaction?.requestId === input.requestId,
                );
          const fingerprint = sha256(
            stableStringify({ ...input, sourcePath: undefined, secrets: undefined }),
          );
          if (
            known?.transaction !== undefined &&
            known.transaction.requestFingerprint !== fingerprint
          )
            throw new BundleInstallationConflictError(
              "installation_request_conflict",
              "This installation request ID was already used with different deployment decisions.",
            );
          if (known?.transaction?.phase === "completed") return known;
          const archive = await readDesktopBundle(
            known === undefined
              ? input.sourcePath
              : options.paths.bundleInstallationArchive(known.id),
            input.rootRef,
            known !== undefined,
          );
          assertBundleHasNoPlugins(archive);
          const unsupportedRequirement = archive.manifest.dependencies.unsupported.find(
            (requirement) => requirement.required,
          );
          if (unsupportedRequirement !== undefined) {
            throw new Error(
              `This Host cannot install required Bundle dependency ${unsupportedRequirement.contract} (${unsupportedRequirement.id}).`,
            );
          }
          if (archive.manifest.bundleFingerprint !== input.expectedFingerprint) {
            throw new Error(
              "The bundle changed after inspection. Inspect it again before importing.",
            );
          }
          if (archive.manifest.projectFingerprint !== input.expectedProjectFingerprint) {
            throw new Error(
              "The portable project changed after inspection. Inspect it again before importing.",
            );
          }
          const catalog = await readCatalog();
          const legacy = catalog.installations.find(
            (record) =>
              record.projectId === options.project.projectId &&
              record.transaction === undefined &&
              (record.status === "installing" || record.status === "failed") &&
              record.bundleFingerprint === archive.manifest.bundleFingerprint &&
              record.sourceRootRef === archive.manifest.root.ref,
          );
          if (known === undefined && legacy !== undefined) {
            throw new BundleInstallationConflictError(
              "installation_legacy_incomplete",
              "An interrupted legacy installation exists. Recheck it or safely discard it before starting a new import.",
            );
          }
          const request = { ...input, sourcePath: undefined, secrets: undefined };
          const requestFingerprint = sha256(stableStringify(request));
          const existing =
            input.requestId === undefined
              ? findIncompleteInstallation(
                  catalog.installations,
                  archive.manifest.bundleFingerprint,
                  archive.manifest.root.ref,
                )
              : catalog.installations.find(
                  (record) =>
                    record.projectId === options.project.projectId &&
                    record.transaction?.requestId === input.requestId,
                );
          const transaction = existing?.transaction;
          if (transaction !== undefined && transaction.requestFingerprint !== requestFingerprint) {
            throw new BundleInstallationConflictError(
              "installation_request_conflict",
              "This installation request ID was already used with different deployment decisions.",
            );
          }
          if (existing !== undefined && transaction?.phase === "completed") return existing;
          const retryingInterruptedImport =
            existing?.status === "failed" || existing?.status === "installing";
          if (existing?.status === "needs_setup" && transaction?.phase !== "assets")
            return existing;
          if (existing !== undefined && transaction === undefined) {
            if (existing.createdResourceRefs.length === existing.resourceRefs.length) {
              await discardCreatedInstallation(existing);
            } else {
              const canRetryLegacyUpdate =
                existing.conflictResolutions.length === 0 &&
                input.conflicts.some((resolution) => resolution.action === "update");
              if (
                !canRetryLegacyUpdate &&
                (!sameConflictResolutions(existing.conflictResolutions, input.conflicts) ||
                  stableStringify(existing.assetConflictResolutions) !==
                    stableStringify(input.assetConflicts ?? []))
              ) {
                throw new Error(
                  "The previous import changed existing resources. Retry it with the same update decisions.",
                );
              }
              await removeInstallationRecord(existing.id);
            }
          }
          const head = await options.project.get();
          const priorPublication =
            transaction === undefined
              ? undefined
              : await options.project.findRevisionByPublicationId(transaction.publicationId);
          const current =
            transaction === undefined || transaction.baseRevision === 0
              ? transaction?.baseRevision === 0
                ? { ...head, revision: 0, resources: [] }
                : head
              : await options.project.getRevision(transaction.baseRevision);
          if (
            transaction !== undefined &&
            head.revision !== transaction.baseRevision &&
            priorPublication === undefined
          ) {
            throw new BundleInstallationConflictError(
              "installation_target_conflict",
              "The project changed during the interrupted installation; inspect the conflict before retrying.",
            );
          }
          if (priorPublication !== undefined && head.revision !== priorPublication.revision) {
            for (const ref of existing!.resourceRefs) {
              const old = priorPublication.resources.find(
                (resource) => canonicalPragmaResourceRef(resource) === ref,
              );
              const latest = head.resources.find(
                (resource) => canonicalPragmaResourceRef(resource) === ref,
              );
              if (stableStringify(old) !== stableStringify(latest))
                throw new BundleInstallationConflictError(
                  "installation_target_conflict",
                  "An installed resource changed after publication. Resolve the conflict before recovery.",
                );
            }
          }
          if (current.revision !== input.expectedProjectRevision) {
            throw new Error("The project changed. Inspect the Bundle again before importing.");
          }
          const identityResolution =
            transaction === undefined
              ? resolveBundleIdentities(
                  archive.resources.filter((resource) => !isPragmaManagementCapability(resource)),
                  current.resources,
                  input.conflicts,
                )
              : { identities: transaction.identities };
          const localized = localizePragmaBundleResources({
            resources: archive.resources,
            manifest: archive.bundle.manifest,
            identities: identityResolution.identities,
          });
          const plan = planBundleResources({
            imported: localized.resources,
            current: current.resources,
            rootRef:
              localized.resourceMappings.get(archive.manifest.root.ref) ??
              archive.manifest.root.ref,
            mappings: localized.resourceMappings,
            conflicts: input.conflicts,
          });
          const dependencies = {
            capabilities: archive.manifest.dependencies.capabilities.filter((value) =>
              plan.sourceRefs.has(value.resourceRef as PragmaResourceRef),
            ),
            contextStores: archive.manifest.dependencies.contextStores.filter((value) =>
              plan.sourceRefs.has(value.resourceRef as PragmaResourceRef),
            ),
            runtimes: archive.manifest.dependencies.runtimes.filter((value) =>
              plan.sourceRefs.has(value.resourceRef as PragmaResourceRef),
            ),
            plugins: archive.manifest.dependencies.plugins.filter((value) =>
              plan.sourceRefs.has(value.ownerRef as PragmaResourceRef),
            ),
            secrets: archive.manifest.dependencies.secrets.filter((value) =>
              plan.sourceRefs.has(value.ownerRef as PragmaResourceRef),
            ),
            unsupported: archive.manifest.dependencies.unsupported.filter((value) =>
              plan.sourceRefs.has(value.ownerRef as PragmaResourceRef),
            ),
          };
          const activeAssetConflicts = (input.assetConflicts ?? []).filter((value) =>
            plan.sourceRefs.has(value.resourceRef),
          );
          const assetResolutionByRef = await validateBundleAssetResolutions({
            archive: { ...archive, manifest: { ...archive.manifest, dependencies } },
            resolutions: activeAssetConflicts,
            capabilities: options.capabilities,
            contextStores: options.contextStores,
            allowAlreadyApplied: retryingInterruptedImport,
            contextResourceUpdates: new Set(
              input.conflicts
                .filter(
                  (resolution) =>
                    resolution.action === "update" &&
                    current.resources.some(
                      (resource) =>
                        resource.kind === "ContextStore" &&
                        canonicalPragmaResourceRef(resource) === resolution.resourceRef,
                    ),
                )
                .map((resolution) => resolution.resourceRef),
            ),
            localSkillAssetFingerprint,
            excludedAssetIds: new Set(
              Object.values(transaction?.assets ?? {}).map((asset) => asset.id),
            ),
          });
          assertUniqueResolutionRefs(input.runtimes, "Runtime");
          assertUniqueResolutionRefs(input.capabilities, "capability");
          assertUniqueResolutionRefs(input.contextStores, "knowledge-base");
          assertResolutionTargets(
            input.runtimes,
            new Set(
              archive.manifest.dependencies.runtimes.map((dependency) => dependency.resourceRef),
            ),
            "Runtime binding",
          );
          assertResolutionTargets(
            input.capabilities,
            new Set(
              archive.manifest.dependencies.capabilities.map(
                (dependency) => dependency.resourceRef,
              ),
            ),
            "Capability binding",
          );
          assertResolutionTargets(
            input.contextStores,
            new Set(
              archive.manifest.dependencies.contextStores.map(
                (dependency) => dependency.resourceRef,
              ),
            ),
            "Knowledge-base binding",
          );
          assertRequirementTargets(
            input.runtimes,
            new Set(
              archive.manifest.dependencies.runtimes.map((dependency) => dependency.requirementId),
            ),
            "Runtime requirement",
          );
          assertRequirementTargets(
            input.capabilities,
            new Set(
              archive.manifest.dependencies.capabilities.map(
                (dependency) => dependency.requirementId,
              ),
            ),
            "Capability requirement",
          );
          assertRequirementTargets(
            input.contextStores,
            new Set(
              archive.manifest.dependencies.contextStores.map(
                (dependency) => dependency.requirementId,
              ),
            ),
            "Knowledge-base requirement",
          );
          const installationId = existing?.transaction === undefined ? randomUUID() : existing.id;
          const archivePath = options.paths.bundleInstallationArchive(installationId);
          await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
          if (transaction === undefined)
            await writeBundleAtomically(archivePath, archive.sourceBytes);
          const timestamp = new Date().toISOString();
          const initial =
            existing?.transaction === undefined
              ? PragmaBundleInstallationSchema.parse({
                  schemaVersion: "pragma.bundle-installation/v9",
                  transaction:
                    input.requestId === undefined
                      ? undefined
                      : {
                          requestId: input.requestId,
                          requestFingerprint,
                          baseRevision: current.revision,
                          publicationId: randomUUID(),
                          input: { ...input, secrets: undefined },
                          identities: identityResolution.identities,
                          assets: {},
                          phase: "assets",
                        },
                  bundleVersion: "pragma.bundle/v3",
                  sourceProjectFingerprint: archive.manifest.projectFingerprint,
                  id: installationId,
                  bundleFingerprint: archive.manifest.bundleFingerprint,
                  projectId: options.project.projectId,
                  projectRevision: current.revision,
                  sourceRootRef: archive.manifest.root.ref,
                  rootRef: archive.manifest.root.ref,
                  rootName: archive.manifest.root.name,
                  rootKind: archive.manifest.root.kind,
                  resourceRefs: [],
                  createdResourceRefs: [],
                  createdCapabilityIds: [],
                  createdContextStoreIds: [],
                  createdPluginRefs: [],
                  conflictResolutions: input.conflicts.filter((value) =>
                    plan.refs.has(
                      localized.resourceMappings.get(value.resourceRef as PragmaResourceRef) ??
                        (value.resourceRef as PragmaResourceRef),
                    ),
                  ),
                  assetConflictResolutions: activeAssetConflicts,
                  resourceMappings: [],
                  status: "installing",
                  pending: [],
                  readiness: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
              : existing;
          if (transaction === undefined) await addInstallation(initial);
          const allocateAsset = async (key: string, proposedId: string, name: string) => {
            const latest = (await readCatalogFile()).installations.find(
              (record) => record.id === initial.id,
            )!;
            const prior = latest.transaction?.assets[key];
            if (prior !== undefined) return prior;
            const allocated = { id: proposedId, name };
            if (latest.transaction !== undefined)
              await updateInstallation(initial.id, (record) => ({
                ...record,
                transaction: {
                  ...record.transaction!,
                  assets: { ...record.transaction!.assets, [key]: allocated },
                },
                createdCapabilityIds: key.startsWith("capability:")
                  ? unique([...record.createdCapabilityIds, allocated.id])
                  : record.createdCapabilityIds,
                createdContextStoreIds: key.startsWith("context:")
                  ? unique([...record.createdContextStoreIds, allocated.id])
                  : record.createdContextStoreIds,
              }));
            return allocated;
          };
          try {
            let resources = plan.resources.map((resource) =>
              isPragmaManagementCapability(resource)
                ? pragmaManagementCapabilityResource()
                : resource,
            );
            const sourceToTarget = new Map(localized.resourceMappings);
            const installationRefs = new Set(plan.refs);
            const replacementRefs = new Set(resources.map(canonicalPragmaResourceRef));
            const currentRefs = new Set(current.resources.map(canonicalPragmaResourceRef));
            let createdResourceRefs = [...replacementRefs].filter((ref) => !currentRefs.has(ref));
            let rootRef =
              sourceToTarget.get(archive.manifest.root.ref) ?? archive.manifest.root.ref;
            await updateInstallation(initial.id, (record) => ({
              ...record,
              rootRef,
              resourceRefs: [...installationRefs],
              createdResourceRefs,
              conflictResolutions: input.conflicts.filter((value) =>
                plan.refs.has(
                  localized.resourceMappings.get(value.resourceRef as PragmaResourceRef) ??
                    (value.resourceRef as PragmaResourceRef),
                ),
              ),
              assetConflictResolutions: activeAssetConflicts,
              resourceMappings: [...sourceToTarget].map(([sourceRef, targetRef]) => ({
                sourceRef,
                targetRef,
              })),
              updatedAt: new Date().toISOString(),
            }));
            const pending: PragmaBundleInstallation["pending"] = [];

            const bundleCapabilityGroups = new Map<
              string,
              (typeof dependencies.capabilities)[number][]
            >();
            for (const dependency of dependencies.capabilities) {
              if (dependency.definition === undefined || !dependency.included) {
                continue;
              }
              const key = bundleCapabilityAssetKey(dependency);
              const group = bundleCapabilityGroups.get(key) ?? [];
              group.push(dependency);
              bundleCapabilityGroups.set(key, group);
            }
            const importedBundleCapabilities = new Map<
              string,
              {
                readonly capability: Awaited<ReturnType<CapabilityStore["get"]>>;
              }
            >();
            for (const group of bundleCapabilityGroups.values()) {
              const temporaryPayloads: string[] = [];
              try {
                const sourceRef = group[0]!.resourceRef as PragmaResourceRef;
                const resourceResolution = input.conflicts.find(
                  (candidate) => candidate.resourceRef === sourceRef,
                );
                const assetResolution = assetResolutionByRef.get(`skill\0${sourceRef}`);
                const targetRef = sourceToTarget.get(sourceRef) ?? sourceRef;
                const targetResource = current.resources.find(
                  (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
                );
                const targetCapabilityId =
                  assetResolution?.targetAssetId ??
                  (targetResource?.kind === "Capability"
                    ? parseDesktopCapabilityBindingRef(targetResource.spec.binding ?? "")
                    : undefined);
                const targetCapability =
                  targetCapabilityId === undefined
                    ? undefined
                    : (await options.capabilities.list()).find(
                        (candidate) => candidate.manifest.id === targetCapabilityId,
                      );
                const importedAssetFingerprint =
                  group[0]!.assetFingerprint ?? group[0]!.definitionFingerprint;
                const targetCapabilityFingerprint =
                  targetCapability === undefined
                    ? undefined
                    : group[0]!.assetFingerprint === undefined
                      ? sha256(stableStringify(targetCapability.definition))
                      : await localSkillAssetFingerprint(targetCapability);
                const targetAlreadyUpdated =
                  retryingInterruptedImport &&
                  assetResolution?.action === "update" &&
                  targetCapabilityFingerprint === importedAssetFingerprint;
                if (
                  assetResolution !== undefined &&
                  assetResolution.action !== "copy" &&
                  !targetAlreadyUpdated &&
                  (targetCapability === undefined ||
                    assetResolution.expectedTarget?.revision !==
                      targetCapability.manifest.latestRevision ||
                    assetResolution.expectedTarget?.fingerprint !== targetCapabilityFingerprint)
                ) {
                  throw new Error(
                    `The target Skill changed after inspection: ${group[0]!.name}. Inspect the Bundle again.`,
                  );
                }
                const importAction = assetResolution?.action ?? resourceResolution?.action;
                if (importAction === "keep_local") {
                  if (targetCapability === undefined) {
                    throw new Error(`The selected local capability is unavailable: ${targetRef}.`);
                  }
                  for (const dependency of group) {
                    importedBundleCapabilities.set(dependency.resourceRef, {
                      capability: targetCapability,
                    });
                  }
                  continue;
                }
                const revisionsByNumber = new Map<
                  number,
                  z.infer<typeof CapabilityDefinitionSchema>
                >();
                let latest:
                  | {
                      readonly revision: number;
                      readonly definition: z.infer<typeof CapabilityDefinitionSchema>;
                      readonly dependency: (typeof group)[number];
                    }
                  | undefined;
                for (const dependency of group) {
                  const history = dependency.history ?? [
                    {
                      revision: dependency.sourceRevision ?? 1,
                      definition: dependency.definition!,
                    },
                  ];
                  for (const historical of history) {
                    const existing = revisionsByNumber.get(historical.revision);
                    if (existing !== undefined) {
                      if (stableStringify(existing) !== stableStringify(historical.definition)) {
                        throw new CapabilityStoreError(
                          "capability_incompatible",
                          `Capability revision ${historical.revision} conflicts inside the Bundle.`,
                        );
                      }
                      continue;
                    }
                    revisionsByNumber.set(historical.revision, historical.definition);
                    if (latest === undefined || historical.revision > latest.revision) {
                      latest = { ...historical, dependency };
                    }
                  }
                }
                if (latest === undefined) {
                  throw new Error(`Capability history is empty: ${group[0]!.name}.`);
                }
                let payloadPath: string | undefined;
                if (latest.definition.kind === "skill") {
                  if (latest.dependency.payloadRoot === undefined) {
                    throw new Error(`Capability payload is incomplete: ${latest.dependency.name}.`);
                  }
                  const historyPrefix = `${latest.dependency.payloadRoot}/history/${formatRevisionDirectory(latest.revision)}`;
                  const currentPrefix = `${latest.dependency.payloadRoot}/files`;
                  const prefix =
                    filesBelowPrefix(archive.files, historyPrefix).size > 0
                      ? historyPrefix
                      : (latest.dependency.sourceRevision === undefined ||
                            latest.revision === latest.dependency.sourceRevision) &&
                          filesBelowPrefix(archive.files, currentPrefix).size > 0
                        ? currentPrefix
                        : undefined;
                  if (prefix === undefined) {
                    throw new Error(
                      `Capability payload is incomplete: ${latest.dependency.name} revision ${latest.revision}.`,
                    );
                  }
                  payloadPath = await materializePrefix(
                    archive.files,
                    prefix,
                    "pragma-bundle-skill-revision-",
                    prefix === currentPrefix
                      ? new Set(
                          latest.dependency.skillFiles
                            ?.filter((file) => file.executable)
                            .map((file) => file.path) ?? [],
                        )
                      : undefined,
                  );
                  if (prefix === currentPrefix && latest.dependency.skillFiles !== undefined) {
                    if (
                      !(await portableSkillDirectoryContentHashes(payloadPath)).has(
                        latest.definition.contentHash,
                      )
                    ) {
                      throw new Error(
                        `Skill payload content hash does not match after extraction: ${latest.dependency.name}.`,
                      );
                    }
                  }
                  temporaryPayloads.push(payloadPath);
                }
                const before = new Set(
                  (await options.capabilities.list()).map((capability) => capability.manifest.id),
                );
                let imported: Awaited<ReturnType<CapabilityStore["get"]>>;
                if (importAction === "update") {
                  if (targetCapability === undefined) {
                    throw new Error(`The selected local capability is unavailable: ${targetRef}.`);
                  }
                  if (
                    targetCapability.definition.kind === "skill" &&
                    latest.definition.kind === "skill" &&
                    payloadPath !== undefined
                  ) {
                    if (targetCapabilityFingerprint === importedAssetFingerprint) {
                      imported = targetCapability;
                    } else {
                      const candidateSnapshot = await scanSkillWorkingTree(payloadPath);
                      imported = await publishTransferredSkill(options.capabilities, {
                        id: targetCapability.manifest.id,
                        name: latest.definition.name,
                        description: latest.definition.description,
                        current: targetCapability,
                        sourcePath: payloadPath,
                        candidateContentHash: candidateSnapshot.hash,
                      });
                    }
                  } else if (
                    targetCapability.definition.kind !== "skill" &&
                    latest.definition.kind !== "skill"
                  ) {
                    imported =
                      stableStringify(targetCapability.definition) ===
                      stableStringify(latest.definition)
                        ? targetCapability
                        : await options.capabilities.update({
                            id: targetCapability.manifest.id,
                            baseRevision: targetCapability.manifest.latestRevision,
                            definition: latest.definition,
                            credentials: {},
                          });
                  } else {
                    throw new CapabilityStoreError(
                      "capability_incompatible",
                      "The imported capability kind does not match the selected local capability.",
                    );
                  }
                } else if (latest.definition.kind === "skill") {
                  if (payloadPath === undefined) {
                    throw new Error("The imported Skill payload is unavailable.");
                  }
                  const proposedName =
                    assetResolution?.action === "copy"
                      ? nextBundleAssetCopyName(
                          latest.definition.name,
                          (await options.capabilities.list())
                            .filter((candidate) => candidate.definition.kind === "skill")
                            .map((candidate) => candidate.definition.name),
                          120,
                        )
                      : latest.definition.name;
                  const allocation = await allocateAsset(
                    `capability:${sourceRef}`,
                    generatePragmaResourceId(),
                    proposedName,
                  );
                  const importedName = allocation.name;
                  if (importedName !== latest.definition.name) {
                    await rewriteSkillName(payloadPath, importedName);
                  }
                  const candidateSnapshot = await scanSkillWorkingTree(payloadPath);
                  imported = await publishTransferredSkill(options.capabilities, {
                    id: allocation.id,
                    name: importedName,
                    description: latest.definition.description,
                    sourcePath: payloadPath,
                    candidateContentHash: candidateSnapshot.hash,
                  });
                } else {
                  const allocation = await allocateAsset(
                    `capability:${sourceRef}`,
                    generatePragmaResourceId(),
                    latest.definition.name,
                  );
                  const prior = await options.capabilities.get(allocation.id).catch((error) => {
                    if (
                      error instanceof CapabilityStoreError &&
                      error.code === "capability_not_found"
                    )
                      return undefined;
                    throw error;
                  });
                  if (
                    prior !== undefined &&
                    (prior.manifest.latestRevision !== 1 ||
                      stableStringify(prior.definition) !== stableStringify(latest.definition))
                  )
                    throw new Error(
                      "The imported capability changed during installation recovery.",
                    );
                  imported =
                    prior ??
                    (await options.capabilities.create(
                      { definition: latest.definition, credentials: {} },
                      { id: allocation.id },
                    ));
                }
                for (const dependency of group) {
                  importedBundleCapabilities.set(dependency.resourceRef, {
                    capability: imported,
                  });
                }
                if (!before.has(imported.manifest.id)) {
                  await updateInstallation(initial.id, (record) => ({
                    ...record,
                    createdCapabilityIds: unique([
                      ...record.createdCapabilityIds,
                      imported.manifest.id,
                    ]),
                    updatedAt: new Date().toISOString(),
                  }));
                }
              } finally {
                await Promise.all(
                  temporaryPayloads.map(
                    async (path) => await rm(path, { recursive: true, force: true }),
                  ),
                );
              }
            }

            for (const dependency of dependencies.capabilities) {
              const targetRef =
                sourceToTarget.get(dependency.resourceRef) ?? dependency.resourceRef;
              const resource = resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              if (resource?.kind !== "Capability") continue;
              if (dependency.resourceRef === PRAGMA_MANAGEMENT_CAPABILITY_REF) continue;
              const importedBundleCapability = importedBundleCapabilities.get(
                dependency.resourceRef,
              );
              const exactCapabilities =
                dependency.included || dependency.definitionFingerprint === undefined
                  ? []
                  : (await options.capabilities.list()).filter(
                      (candidate) =>
                        sha256(stableStringify(candidate.definition)) ===
                        dependency.definitionFingerprint,
                    );
              const capabilityCandidates =
                dependency.definitionFingerprint === undefined
                  ? (await options.capabilities.list()).filter(
                      (candidate) =>
                        dependency.kind === undefined ||
                        candidate.definition.kind === dependency.kind,
                    )
                  : exactCapabilities;
              const explicitCapability = input.capabilities.find(
                (candidate) => candidate.resourceRef === dependency.resourceRef,
              );
              let capability =
                !dependency.included && explicitCapability !== undefined
                  ? await resolveCapabilityForBinding(
                      options.capabilities,
                      explicitCapability.capabilityId,
                    )
                  : importedBundleCapability?.capability;
              capability ??= exactCapabilities.length === 1 ? exactCapabilities[0] : undefined;
              if (
                capability !== undefined &&
                dependency.kind !== undefined &&
                capability.definition.kind !== dependency.kind
              )
                throw new Error(`Choose a ${dependency.kind} capability for ${dependency.name}.`);
              if (
                capability === undefined &&
                dependency.included &&
                dependency.definition !== undefined
              ) {
                if (dependency.kind === "skill" && dependency.payloadRoot !== undefined) {
                  const temporary = await materializePrefix(
                    archive.files,
                    `${dependency.payloadRoot}/files`,
                    "pragma-bundle-skill-",
                  );
                  try {
                    capability = await options.capabilities.importSkill({
                      sourcePath: temporary,
                      name: dependency.name,
                      description: dependency.definition.description,
                    });
                  } finally {
                    await rm(temporary, { recursive: true, force: true });
                  }
                } else if (dependency.kind !== "skill") {
                  capability = await options.capabilities.create(
                    CreateCapabilitySchema.parse({
                      definition: dependency.definition,
                      credentials: {},
                    }),
                  );
                }
                if (capability !== undefined) {
                  await updateInstallation(initial.id, (record) => ({
                    ...record,
                    createdCapabilityIds: unique([
                      ...record.createdCapabilityIds,
                      capability!.manifest.id,
                    ]),
                    updatedAt: new Date().toISOString(),
                  }));
                }
              }
              if (capability === undefined) {
                const resolution = input.capabilities.find(
                  (candidate) => candidate.resourceRef === dependency.resourceRef,
                );
                if (resolution !== undefined) {
                  capability = await resolveCapabilityForBinding(
                    options.capabilities,
                    resolution.capabilityId,
                  );
                  if (
                    dependency.kind !== undefined &&
                    capability.definition.kind !== dependency.kind
                  ) {
                    throw new Error(
                      `Choose a ${dependency.kind} capability for ${dependency.name}.`,
                    );
                  }
                }
              }
              if (capability === undefined) {
                resource.spec.binding = pendingBinding(installationId, targetRef);
                pending.push({
                  id: dependency.requirementId,
                  kind: "capability",
                  resourceRef: targetRef,
                  name: dependency.name,
                  message:
                    capabilityCandidates.length > 1
                      ? "Multiple local Capability assets are candidates. Choose an explicit binding."
                      : "Choose or install a compatible capability.",
                  ...(capabilityCandidates.length > 1
                    ? {
                        status: "action_required" as const,
                        code: "binding_ambiguous",
                        action: "choose_capability" as const,
                      }
                    : {}),
                  ...(dependency.kind === undefined ? {} : { capabilityKind: dependency.kind }),
                });
              } else {
                capability = await resolveCapabilityForBinding(
                  options.capabilities,
                  capability.manifest.id,
                );
                Object.assign(
                  resource,
                  bindExistingDesktopCapabilityResource(resource, {
                    id: capability.manifest.id,
                  }),
                );
                if (capability.health.status !== "ready") {
                  pending.push({
                    id: dependency.requirementId,
                    kind: "capability",
                    resourceRef: targetRef,
                    name: dependency.name,
                    message: "Complete capability setup before using this Bundle.",
                    capabilityKind: capability.definition.kind,
                    status: "action_required",
                    code: capability.health.diagnostic?.code ?? "capability_needs_attention",
                    action: "configure_capability",
                    targetId: capability.manifest.id,
                  });
                }
              }
            }

            for (const dependency of dependencies.contextStores) {
              const targetRef =
                sourceToTarget.get(dependency.resourceRef) ?? dependency.resourceRef;
              const resource = resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              if (resource?.kind !== "ContextStore") continue;
              const stores = await options.contextStores.list();
              let contextAmbiguous = false;
              if (!dependency.included && dependency.fingerprint !== undefined) {
                const matches = (
                  await Promise.all(
                    stores.map(async (candidate) => ({
                      store: candidate,
                      fingerprint: await options.contextStores
                        .fingerprint(candidate.id)
                        .catch(() => undefined),
                    })),
                  )
                ).filter((candidate) => candidate.fingerprint === dependency.fingerprint);
                const resolution = input.contextStores.find(
                  (candidate) => candidate.resourceRef === dependency.resourceRef,
                );
                contextAmbiguous = resolution === undefined && matches.length > 1;
                if (resolution === undefined && matches.length === 1) {
                  const match = matches[0]!.store;
                  Object.assign(
                    resource,
                    bindExistingDesktopContextResource(resource, match.id, {
                      name: match.name,
                      description: resource.metadata.description,
                    }),
                  );
                  continue;
                }
              }

              const conflictAction = input.conflicts.find(
                (candidate) => candidate.resourceRef === dependency.resourceRef,
              );
              const assetResolution = assetResolutionByRef.get(
                `knowledge_base\0${dependency.resourceRef}`,
              );
              const importAction = assetResolution?.action ?? conflictAction?.action;
              const currentResource = current.resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              const updateStoreId =
                assetResolution?.targetAssetId ??
                ((importAction === "update" || importAction === "keep_local") &&
                currentResource?.kind === "ContextStore"
                  ? parseDesktopContextBindingRef(currentResource.spec.binding ?? "")
                  : undefined);
              let store =
                updateStoreId === undefined
                  ? undefined
                  : stores.find((candidate) => candidate.id === updateStoreId);
              if (
                (importAction === "update" || importAction === "keep_local") &&
                store === undefined
              ) {
                throw new Error(
                  `The matched knowledge base is not bound to an available managed Store: ${targetRef}.`,
                );
              }
              if (
                store !== undefined &&
                dependency.snapshot !== undefined &&
                importAction !== "keep_local"
              ) {
                const currentSnapshot = await options.contextStores.getSnapshot(store.id);
                const targetFingerprint = knowledgeBaseAssetFingerprint({
                  name: store.name,
                  description: store.description,
                  snapshotHash: currentSnapshot.snapshotHash,
                });
                const importedFingerprint = knowledgeBaseAssetFingerprint({
                  name: dependency.name,
                  description: dependency.description,
                  snapshotHash: dependency.snapshot.snapshotHash,
                });
                const targetAlreadyUpdated =
                  retryingInterruptedImport &&
                  importAction === "update" &&
                  targetFingerprint === importedFingerprint;
                const assetTargetChanged =
                  assetResolution !== undefined &&
                  !targetAlreadyUpdated &&
                  (assetResolution.expectedTarget?.revision !== currentSnapshot.revision ||
                    assetResolution.expectedTarget?.fingerprint !== targetFingerprint);
                const resourceTargetChanged =
                  assetResolution === undefined &&
                  !targetAlreadyUpdated &&
                  conflictAction?.action === "update" &&
                  (conflictAction.expectedTargetRevision !== currentSnapshot.revision ||
                    conflictAction.expectedTargetSnapshotHash !== currentSnapshot.snapshotHash);
                if (importAction === "update" && (assetTargetChanged || resourceTargetChanged)) {
                  throw new Error(
                    "The target knowledge base changed. Inspect the Bundle again before importing.",
                  );
                }
                if (archive.manifest.root.kind === "ContextStore") {
                  await updateInstallation(initial.id, (record) => ({
                    ...record,
                    knowledgeBaseUpdate: {
                      sourceRef: dependency.resourceRef,
                      targetRef,
                      storeId: store!.id,
                      baseRevision: currentSnapshot.revision,
                      baseSnapshotHash: currentSnapshot.snapshotHash,
                      importedSnapshotHash: dependency.snapshot!.snapshotHash,
                      importedName: dependency.name,
                      importedDescription: dependency.description,
                      phase: "prepared",
                    },
                    updatedAt: new Date().toISOString(),
                  }));
                }
                if (targetFingerprint !== importedFingerprint) {
                  await appendTransferredKnowledge(
                    options.contextStores,
                    {
                      storeId: store.id,
                      baseRevision: currentSnapshot.revision,
                      baseSnapshotHash: currentSnapshot.snapshotHash,
                      snapshotHash: dependency.snapshot.snapshotHash,
                      directories: dependency.snapshot.directories,
                      files: dependency.snapshot.files,
                      summary: "Append imported knowledge-base snapshot.",
                      name: dependency.name,
                      description: dependency.description,
                    },
                    "import",
                  );
                  store = (await options.contextStores.list()).find(
                    (candidate) => candidate.id === updateStoreId,
                  );
                }
                if (archive.manifest.root.kind === "ContextStore") {
                  await updateInstallation(initial.id, (record) => ({
                    ...record,
                    knowledgeBaseUpdate: {
                      ...record.knowledgeBaseUpdate!,
                      phase: "applied",
                    },
                    updatedAt: new Date().toISOString(),
                  }));
                }
              }
              if (store === undefined && dependency.snapshot !== undefined) {
                const proposedName =
                  assetResolution?.action === "copy"
                    ? nextBundleAssetCopyName(
                        dependency.name,
                        stores.map((candidate) => candidate.name),
                        200,
                      )
                    : dependency.name;
                const allocation = await allocateAsset(
                  `context:${dependency.resourceRef}`,
                  randomUUID(),
                  proposedName,
                );
                const importedStoreId = allocation.id;
                const importedName = allocation.name;
                const prior = await options.contextStores.get(importedStoreId).catch((error) => {
                  if (
                    typeof error === "object" &&
                    error !== null &&
                    "code" in error &&
                    error.code === "store_not_found"
                  )
                    return undefined;
                  throw error;
                });
                if (
                  prior !== undefined &&
                  (prior.contentRevision !== 1 ||
                    prior.name !== importedName ||
                    prior.description !== dependency.description ||
                    (await options.contextStores.getSnapshot(importedStoreId)).snapshotHash !==
                      dependency.snapshot.snapshotHash)
                )
                  throw new Error(
                    "The imported knowledge base changed during installation recovery.",
                  );
                if (archive.manifest.root.kind === "ContextStore") {
                  await updateInstallation(initial.id, (record) => ({
                    ...record,
                    knowledgeBaseUpdate: {
                      sourceRef: dependency.resourceRef,
                      targetRef,
                      storeId: importedStoreId,
                      importedSnapshotHash: dependency.snapshot!.snapshotHash,
                      importedName,
                      importedDescription: dependency.description,
                      phase: "prepared",
                    },
                    updatedAt: new Date().toISOString(),
                  }));
                }
                store =
                  prior ??
                  (await options.contextStores.createFromSnapshot({
                    id: importedStoreId,
                    name: importedName,
                    description: dependency.description,
                    directories: dependency.snapshot.directories,
                    files: dependency.snapshot.files,
                    author: "import",
                    summary: "Import current knowledge-base snapshot from a Pragma Bundle.",
                    expectedSnapshotHash: dependency.snapshot.snapshotHash,
                  }));
                await updateInstallation(initial.id, (record) => ({
                  ...record,
                  createdContextStoreIds: unique([...record.createdContextStoreIds, store!.id]),
                  ...(archive.manifest.root.kind === "ContextStore"
                    ? {
                        knowledgeBaseUpdate: {
                          ...record.knowledgeBaseUpdate!,
                          phase: "applied" as const,
                        },
                      }
                    : {}),
                  updatedAt: new Date().toISOString(),
                }));
              }
              if (
                store === undefined &&
                dependency.included &&
                dependency.payloadRoot !== undefined
              ) {
                const temporary = await materializePrefix(
                  archive.files,
                  dependency.payloadRoot,
                  "pragma-bundle-context-",
                );
                try {
                  store = await options.contextStores.create({
                    mode: "import",
                    name: dependency.name,
                    description: dependency.description,
                    sourcePath: temporary,
                  });
                  await updateInstallation(initial.id, (record) => ({
                    ...record,
                    createdContextStoreIds: unique([...record.createdContextStoreIds, store!.id]),
                    updatedAt: new Date().toISOString(),
                  }));
                } finally {
                  await rm(temporary, { recursive: true, force: true });
                }
              }
              if (store === undefined) {
                const resolution = input.contextStores.find(
                  (candidate) => candidate.resourceRef === dependency.resourceRef,
                );
                if (resolution !== undefined) {
                  await options.contextStores.resolve(resolution.storeId);
                  store = stores.find((candidate) => candidate.id === resolution.storeId);
                  if (store === undefined) {
                    throw new Error(`Knowledge base is unavailable: ${resolution.storeId}.`);
                  }
                }
              }
              if (store === undefined) {
                resource.spec.binding = pendingBinding(installationId, targetRef);
                pending.push({
                  id: dependency.requirementId,
                  kind: "context-store",
                  resourceRef: targetRef,
                  name: dependency.name,
                  message: contextAmbiguous
                    ? "Multiple exact knowledge bases match. Choose an explicit binding."
                    : "Choose an existing knowledge base or import its Markdown files.",
                  ...(contextAmbiguous
                    ? {
                        status: "action_required" as const,
                        code: "binding_ambiguous",
                        action: "choose_knowledge_base" as const,
                      }
                    : {}),
                });
              } else {
                Object.assign(
                  resource,
                  bindExistingDesktopContextResource(resource, store.id, {
                    name: store.name,
                    description: store.description,
                  }),
                );
              }
            }

            const runtimes = await options.getRuntimes();
            for (const dependency of dependencies.runtimes) {
              const targetRef =
                sourceToTarget.get(dependency.resourceRef) ?? dependency.resourceRef;
              const resource = resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              if (resource?.kind !== "RuntimeProfile") continue;
              const exact = runtimes.find((runtime) =>
                runtimeDependencyAvailable(runtime, dependency),
              );
              const resolution = input.runtimes.find(
                (candidate) => candidate.resourceRef === dependency.resourceRef,
              );
              if (resolution !== undefined || exact === undefined) {
                if (resolution !== undefined)
                  resource.spec.config = rebindRuntimeConfig(resource.spec.config, resolution);
                if (
                  resolution === undefined ||
                  !runtimes.some((runtime) =>
                    runtimeDependencyAvailable(runtime, {
                      resourceRef: resolution.resourceRef,
                      name: dependency.name,
                      runtimeId: resolution.runtimeId,
                      providerId: resolution.providerId,
                      modelId: resolution.modelId,
                      thinkingLevel: resolution.thinkingLevel,
                    }),
                  )
                ) {
                  pending.push({
                    id: dependency.requirementId,
                    kind: "runtime",
                    resourceRef: targetRef,
                    name: dependency.name,
                    message: "Choose a compatible local Runtime and model.",
                  });
                } else {
                  resource.spec.config = rebindRuntimeConfig(resource.spec.config, resolution);
                }
              }
            }

            const secretById = new Map(
              dependencies.secrets.map((requirement) => [requirement.id, requirement]),
            );
            for (const requirementId of Object.keys(input.secrets)) {
              if (!secretById.has(requirementId)) {
                throw new Error(`Secret is not requested by this Bundle: ${requirementId}.`);
              }
            }
            if (Object.keys(input.secrets).length > 0) {
              await options.plugins.setSecrets(
                Object.fromEntries(
                  Object.entries(input.secrets).map(([requirementId, value]) => [
                    `binding:pragma.bundle.${requirementId}`,
                    value,
                  ]),
                ),
              );
            }
            const secretReadiness = await Promise.all(
              dependencies.secrets.map(
                async (requirement): Promise<PragmaBundleDependencyReadiness> => {
                  const binding = `binding:pragma.bundle.${requirement.id}`;
                  const available = await options.plugins.hasSecret(binding);
                  return {
                    id: requirement.id,
                    kind: "secret",
                    resourceRef: sourceToTarget.get(requirement.ownerRef) ?? requirement.ownerRef,
                    name: requirement.name,
                    status: available ? "ready" : "missing",
                    code: available ? "ready" : "secret_missing",
                    action: available ? "none" : "enter_secret",
                    message: available
                      ? "Secret is ready."
                      : `Enter the secret for ${requirement.name}.`,
                  };
                },
              ),
            );
            for (const dependency of secretReadiness.filter(
              (dependency) => dependency.status !== "ready",
            )) {
              pending.push(readinessToPending([dependency])[0]!);
            }

            const currentArtifacts =
              current.revision === 0
                ? new Map<string, string>()
                : await options.project.readArtifacts(current.revision);
            const importedArtifacts = new Map<string, string>();
            for (const sourcePath of archive.manifest.projectArtifacts) {
              for (const [path, contents] of archive.files) {
                if (path === sourcePath || path.startsWith(`${sourcePath.replace(/\/+$/, "")}/`)) {
                  importedArtifacts.set(`imports/${installationId}/${path}`, strFromU8(contents));
                }
              }
            }
            resources = [
              ...remapPragmaProjectArtifactPaths(
                resources,
                Object.fromEntries(
                  archive.manifest.projectArtifacts.map((path) => [
                    path,
                    `imports/${installationId}/${path}`,
                  ]),
                ),
              ),
            ];
            let combined = [
              ...current.resources.filter(
                (resource) => !replacementRefs.has(canonicalPragmaResourceRef(resource)),
              ),
              ...resources,
            ];
            const normalized = await options.project.normalizeResources(combined);
            combined = normalized.resources;
            const resolveRef = (ref: string) => normalized.aliases.get(ref) ?? ref;
            for (const [source, target] of sourceToTarget)
              sourceToTarget.set(source, resolveRef(target) as typeof target);
            const normalizedRefs = [...installationRefs].map(resolveRef);
            installationRefs.clear();
            for (const ref of normalizedRefs) installationRefs.add(ref as PragmaResourceRef);
            createdResourceRefs = unique(createdResourceRefs.map(resolveRef)).filter(
              (ref) => !currentRefs.has(ref),
            );
            rootRef = resolveRef(rootRef) as typeof rootRef;
            for (const dependency of [...pending, ...secretReadiness])
              dependency.resourceRef = resolveRef(dependency.resourceRef);
            // Persist the normalized ownership and mapping before publication. Replaying an
            // interrupted transaction recomputes this deterministic graph from its base revision.
            await updateInstallation(initial.id, (record) => ({
              ...record,
              rootRef,
              resourceRefs: [...installationRefs],
              createdResourceRefs,
              resourceMappings: [...sourceToTarget].map(([sourceRef, targetRef]) => ({
                sourceRef,
                targetRef,
              })),
            }));
            const referencedArtifacts = collectPragmaProjectArtifactPaths(combined);
            const retainedCurrentArtifacts = [...currentArtifacts].filter(
              ([path]) =>
                !isBundleOwnedArtifact(path) || artifactPathIsReferenced(path, referencedArtifacts),
            );
            const published =
              priorPublication ??
              (await options.project.publish({
                publicationId: initial.transaction?.publicationId,
                expectedRevision: current.revision,
                resources: combined,
                artifacts: new Map([...retainedCurrentArtifacts, ...importedArtifacts]),
              }));
            await updateInstallation(initial.id, (record) => ({
              ...record,
              projectRevision: published.revision,
              ...(record.transaction === undefined
                ? {}
                : { transaction: { ...record.transaction, phase: "published" } }),
              resourceRefs: [...installationRefs],
              createdResourceRefs,
              updatedAt: new Date().toISOString(),
            }));

            for (const flow of resources.filter((resource) => resource.kind === "Flow")) {
              const sourceFlow = archive.resources.find(
                (candidate) =>
                  candidate.kind === "Flow" &&
                  sourceToTarget.get(canonicalPragmaResourceRef(candidate)) ===
                    canonicalPragmaResourceRef(flow),
              );
              if (sourceFlow?.kind !== "Flow") continue;
              const layoutFile = archive.files.get(`layouts/flows/${sourceFlow.metadata.id}.json`);
              if (layoutFile === undefined) continue;
              const layout = WorkflowLayoutSchema.parse(JSON.parse(strFromU8(layoutFile)));
              await options.layouts.save({
                schemaVersion: "pragma.desktop-flow-layout/v2",
                projectId: published.projectId,
                flowId: flow.metadata.id,
                nodes: layout.nodes,
                viewport: layout.viewport,
                updatedAt: new Date().toISOString(),
              });
            }

            const verifiedReadiness = await inspectAssetReadiness(
              collectBundleResourceClosure(published.resources, rootRef),
              {
                capabilities: options.capabilities,
                contextStores: options.contextStores,
                plugins: options.plugins,
                runtimes: await options.getRuntimes(),
              },
            );
            const allReadiness = mergeReadiness(verifiedReadiness, [
              ...secretReadiness,
              ...pending.map(readinessFromPending),
            ]);
            const allPending = mergePendingMetadata(readinessToPending(allReadiness), pending);
            const completed = await updateInstallation(initial.id, (record) => ({
              ...record,
              projectRevision: published.revision,
              rootRef,
              rootName:
                published.resources.find(
                  (resource) => canonicalPragmaResourceRef(resource) === rootRef,
                )?.metadata.name ?? record.rootName,
              resourceRefs: [...installationRefs],
              createdResourceRefs,
              ...(record.transaction === undefined
                ? {}
                : { transaction: { ...record.transaction, phase: "completed" } }),
              status: allPending.length === 0 ? "ready" : "needs_setup",
              pending: allPending,
              readiness: allReadiness,
              updatedAt: new Date().toISOString(),
            }));
            if (completed.status === "ready") {
              await cleanupInstallationArchive(completed.id);
            }
            return completed;
          } catch (error) {
            return await updateInstallation(initial.id, (record) => ({
              ...record,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              errorCode: installationErrorCode(error),
              updatedAt: new Date().toISOString(),
            }));
          }
        },
      );
    },

    async listInstallations() {
      return (await readCatalog()).installations.toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    },

    async recheckInstallation(installationId) {
      return await withFileLock(
        join(options.paths.bundleInstallationStateRoot(installationId), "repair.lock"),
        async () => {
          const repaired = await recoverBindingRepair(installationId);
          if (repaired !== undefined) return repaired;
          const installation = (await readCatalog()).installations.find(
            (candidate) => candidate.id === installationId,
          );
          if (installation === undefined) throw new Error("Bundle installation not found.");
          if (
            installation.transaction !== undefined &&
            installation.transaction.phase !== "completed"
          ) {
            const input = StartPragmaBundleImportSchema.parse({
              ...installation.transaction.input,
              sourcePath: options.paths.bundleInstallationArchive(installation.id),
              secrets: {},
            });
            return await service.startImport(input);
          }
          if (
            (installation.status === "installing" || installation.status === "failed") &&
            installation.transaction === undefined
          ) {
            await recoverKnowledgeBaseInstallation(installation).catch(async (error) => {
              await updateInstallation(installation.id, (record) => ({
                ...record,
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
                errorCode:
                  installation.knowledgeBaseUpdate === undefined
                    ? "installation_legacy_recovery_unavailable"
                    : installationErrorCode(error),
              }));
            });
            return (await readCatalogFile()).installations.find(
              (record) => record.id === installation.id,
            )!;
          }
          return await recheck(installation);
        },
      );
    },

    async rebindInstallation(input) {
      input = ResolvePragmaBundleInstallationSchema.parse(input);
      return await withFileLock(
        join(options.paths.bundleInstallationStateRoot(input.installationId), "repair.lock"),
        async () => {
          await recoverBindingRepair(input.installationId);
          const installation = (await readCatalog()).installations.find(
            (record) => record.id === input.installationId,
          );
          if (
            installation === undefined ||
            installation.projectId !== options.project.projectId ||
            !isRecheckableInstallation(installation)
          )
            throw new Error("This installation cannot be rebound.");
          const snapshot = await options.project.get();
          if (snapshot.revision !== input.baseRevision)
            throw new Error("The project changed. Reload setup before rebinding.");
          const bindingScope = new Set([
            ...installation.resourceRefs,
            ...(await currentInstallationResources(installation, snapshot)).map(
              canonicalPragmaResourceRef,
            ),
          ]);
          const selected = new Set(
            [...input.runtimes, ...input.capabilities, ...input.contextStores].map(
              (value) => value.resourceRef,
            ),
          );
          if ([...selected].some((ref) => !bindingScope.has(ref)))
            throw new Error("The binding is outside the selected installation.");
          const outside = snapshot.resources.filter(
            (resource) => !bindingScope.has(canonicalPragmaResourceRef(resource)),
          );
          const otherInstallations = (await readCatalog()).installations.filter(
            (record) => record.id !== installation.id,
          );
          const shared = new Set(otherInstallations.flatMap((record) => record.resourceRefs));
          for (const resource of outside)
            for (const ref of referencedPragmaResourceRefs([resource])) shared.add(ref);
          // Clone changed dependencies and the reference path to the selected root, using Interpreter's typed rewriter.
          let discovered = true;
          while (discovered) {
            discovered = false;
            for (const resource of snapshot.resources) {
              if (!shared.has(canonicalPragmaResourceRef(resource))) continue;
              for (const dependency of referencedPragmaResourceRefs([resource]))
                if (!shared.has(dependency)) {
                  shared.add(dependency);
                  discovered = true;
                }
            }
          }
          const cloning = new Set([...selected].filter((ref) => shared.has(ref)));
          let changed = true;
          while (changed) {
            changed = false;
            for (const resource of snapshot.resources) {
              const ref = canonicalPragmaResourceRef(resource);
              if (!bindingScope.has(ref) || cloning.has(ref) || !shared.has(ref)) continue;
              if (
                [...referencedPragmaResourceRefs([resource])].some((dependency) =>
                  cloning.has(dependency),
                )
              ) {
                cloning.add(ref);
                changed = true;
              }
            }
          }
          const resources = snapshot.resources.filter((resource) =>
            bindingScope.has(canonicalPragmaResourceRef(resource)),
          );
          const localized = remapPragmaResourceIdentities({
            resources,
            identities: resolveBundleIdentities(
              resources,
              snapshot.resources,
              resources.map((resource) => ({
                resourceRef: canonicalPragmaResourceRef(resource),
                action: cloning.has(canonicalPragmaResourceRef(resource)) ? "copy" : "keep_local",
              })),
            ).identities,
          });
          const mapRef = (ref: string) =>
            localized.resourceMappings.get(ref as PragmaResourceRef) ?? ref;
          const translated = {
            ...input,
            runtimes: input.runtimes.map((value) => ({
              ...value,
              resourceRef: mapRef(value.resourceRef),
            })),
            capabilities: input.capabilities.map((value) => ({
              ...value,
              resourceRef: mapRef(value.resourceRef),
            })),
            contextStores: input.contextStores.map((value) => ({
              ...value,
              resourceRef: mapRef(value.resourceRef),
            })),
          };
          // Validate and apply once in resolveInstallation. No Project publication occurs before validation.
          return await resolveInstallationBindings(translated, {
            installation,
            snapshot,
            localized,
            selected,
          });
        },
      );
    },
    async resolveInstallation(input) {
      input = ResolvePragmaBundleInstallationSchema.parse(input);
      const record = (await readCatalog()).installations.find(
        (value) => value.id === input.installationId,
      );
      if (record === undefined) throw new Error("Bundle installation not found.");
      if (record.projectId !== options.project.projectId || record.status !== "needs_setup")
        throw new Error("This bundle installation is not awaiting setup.");
      for (const [kind, values] of [
        ["runtime", input.runtimes],
        ["capability", input.capabilities],
        ["context-store", input.contextStores],
      ] as const)
        for (const value of values)
          if (
            !record.pending.some(
              (dependency) =>
                dependency.kind === kind && dependency.resourceRef === value.resourceRef,
            )
          )
            throw new Error(`The requested ${kind} binding is not pending in this installation.`);
      return await service.rebindInstallation(input);
    },

    async discardInstallation(installationId) {
      return await withFileLock(
        join(options.paths.bundleInstallationStateRoot(installationId), "repair.lock"),
        async () => {
          const catalog = await readCatalog();
          const installation = catalog.installations.find((item) => item.id === installationId);
          if (installation === undefined) return;
          await withFileLock(
            options.paths.bundleImportLock(
              installation.transaction?.requestId ?? installation.bundleFingerprint,
            ),
            async () => {
              const latest = (await readCatalog()).installations.find(
                (record) => record.id === installationId,
              );
              if (latest !== undefined) await discardCreatedInstallation(latest);
            },
          );
        },
      );
    },

    async getReadinessForRef(ref, input) {
      const parsed = PragmaInvocableResourceRefSchema.safeParse(ref);
      if (!parsed.success) return [];
      const snapshot = input?.snapshot ?? (await options.project.get());
      const root = snapshot.resources.find(
        (resource): resource is PragmaInvocableResource =>
          canonicalPragmaResourceRef(resource) === parsed.data &&
          (resource.kind === "Expert" ||
            resource.kind === "ExpertTeam" ||
            resource.kind === "Flow"),
      );
      if (root === undefined) return [];
      const project = await options.project.openRevision(snapshot.revision);
      try {
        const closureRefs = new Set(
          project.listResourceClosure(parsed.data).map(canonicalPragmaResourceRef),
        );
        const installations = (await readCatalog()).installations
          .filter((installation) =>
            installation.resourceRefs.some((resourceRef) => closureRefs.has(resourceRef)),
          )
          .sort(
            (left, right) =>
              Number(isRecheckableInstallation(right)) - Number(isRecheckableInstallation(left)) ||
              Number(right.rootRef === parsed.data) - Number(left.rootRef === parsed.data) ||
              left.id.localeCompare(right.id),
          );
        const runtimes =
          input?.runtimes ?? (installations.length > 0 ? await options.getRuntimes() : []);
        const readiness = await Promise.all(
          installations.map(async (installation) => {
            // Admission inspects live bindings even for interrupted imports. Persisted diagnostics
            // describe the failed attempt, not the current resources; recovery remains explicit.
            const current = (
              await evaluateInstallation(installation, snapshot, false, runtimes, closureRefs)
            ).readiness;
            return current
              .filter(
                (dependency) =>
                  dependency.status !== "ready" && closureRefs.has(dependency.resourceRef),
              )
              .map((dependency) => ({ ...dependency, installationId: installation.id }));
          }),
        );
        // Installation history can overlap; admission reports each logical dependency once.
        // Secrets have installation-owned identities, while plugins are scoped to their Expert.
        const unique = new Map<string, PragmaBundleDependencyReadiness>();
        for (const dependency of readiness.flat()) {
          const key = JSON.stringify([
            dependency.kind,
            dependency.resourceRef,
            dependency.kind === "secret" || dependency.kind === "plugin"
              ? dependency.id
              : undefined,
          ]);
          if (!unique.has(key)) unique.set(key, dependency);
        }
        return [...unique.values()];
      } finally {
        await project.dispose();
      }
    },

    async isRefPending(ref) {
      return (await this.getReadinessForRef(ref)).length > 0;
    },
  };
  return service;
}

interface DesktopBundleArchive {
  readonly sourceBytes: Uint8Array;
  readonly bundle: DecodedPragmaBundle;
  readonly manifest: {
    readonly bundleFingerprint: string;
    readonly projectFingerprint: string;
    readonly createdAt: string;
    readonly roots: readonly {
      readonly ref: string;
      readonly kind: "Expert" | "ExpertTeam" | "Flow" | "ContextStore" | "Capability";
      readonly name: string;
    }[];
    readonly root: {
      readonly ref: string;
      readonly kind: "Expert" | "ExpertTeam" | "Flow" | "ContextStore" | "Capability";
      readonly name: string;
    };
    readonly projectArtifacts: readonly string[];
    readonly dependencies: {
      readonly capabilities: readonly {
        readonly requirementId: string;
        readonly resourceRef: string;
        readonly name: string;
        readonly kind?: "skill" | "mcp_server" | "http_service" | "code_service";
        readonly definitionFingerprint?: string;
        readonly assetFingerprint?: string;
        readonly definition?: z.infer<typeof CapabilityDefinitionSchema>;
        readonly logicalId?: string;
        readonly sourceRevision?: number;
        readonly history?: readonly {
          readonly revision: number;
          readonly definition: z.infer<typeof CapabilityDefinitionSchema>;
        }[];
        readonly included: boolean;
        readonly payloadRoot?: string;
        readonly payloadCodec?: string;
        readonly skillFiles?: readonly SkillBundleFile[];
      }[];
      readonly contextStores: readonly {
        readonly requirementId: string;
        readonly resourceRef: string;
        readonly name: string;
        readonly description: string;
        readonly fingerprint?: string;
        readonly sourceId?: string;
        readonly contentIncluded?: boolean;
        readonly snapshot?: z.infer<typeof ContextStoreSnapshotSchema>;
        readonly included: boolean;
        readonly payloadRoot?: string;
      }[];
      readonly plugins: readonly {
        readonly requirementId: string;
        readonly ownerRef: string;
        readonly ref: string;
        readonly name: string;
        readonly included: boolean;
        readonly payloadRoot?: string;
      }[];
      readonly runtimes: readonly {
        readonly requirementId: string;
        readonly resourceRef: string;
        readonly name: string;
        readonly runtimeId?: string;
        readonly providerId?: string;
        readonly modelId?: string;
        readonly thinkingLevel?: string;
      }[];
      readonly secrets: readonly PragmaBundleRequirement[];
      readonly unsupported: readonly PragmaBundleRequirement[];
    };
  };
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly resources: readonly PragmaResource[];
  readonly archiveBytes: number;
  readonly fileCount: number;
  readonly unpackedBytes: number;
}

function assertBundleHasNoPlugins(archive: DesktopBundleArchive): void {
  if (
    archive.manifest.dependencies.plugins.length > 0 ||
    archive.resources.some(
      (resource) => resource.kind === "Expert" && resource.spec.plugins.length > 0,
    )
  ) {
    throw new BundlePluginUnavailableError("import");
  }
}

async function validateBundleAssetResolutions(input: {
  readonly archive: DesktopBundleArchive;
  readonly resolutions: readonly BundleAssetResolution[];
  readonly capabilities: CapabilityStore;
  readonly contextStores: ContextStoreStore;
  readonly allowAlreadyApplied: boolean;
  readonly contextResourceUpdates?: ReadonlySet<string>;
  readonly excludedAssetIds?: ReadonlySet<string>;
  readonly localSkillAssetFingerprint: (
    capability: Awaited<ReturnType<CapabilityStore["get"]>>,
  ) => Promise<string>;
}): Promise<ReadonlyMap<string, BundleAssetResolution>> {
  const resolutionByRef = new Map<string, BundleAssetResolution>();
  for (const resolution of input.resolutions) {
    const key = `${resolution.assetKind}\0${resolution.resourceRef}`;
    if (resolutionByRef.has(key)) {
      throw new Error(`Choose one asset import action for ${resolution.resourceRef}.`);
    }
    resolutionByRef.set(key, resolution);
  }

  const capabilities = (await input.capabilities.list()).filter(
    (value) => !input.excludedAssetIds?.has(value.manifest.id),
  );
  const stores = (await input.contextStores.list()).filter(
    (value) => !input.excludedAssetIds?.has(value.id),
  );
  const expectedKeys = new Set<string>();
  const inspectedSkillAssets = new Set<string>();
  for (const dependency of input.archive.manifest.dependencies.capabilities) {
    if (
      !dependency.included ||
      dependency.kind !== "skill" ||
      dependency.definitionFingerprint === undefined
    ) {
      continue;
    }
    const assetKey = bundleCapabilityAssetKey(dependency);
    if (inspectedSkillAssets.has(assetKey)) continue;
    inspectedSkillAssets.add(assetKey);
    const candidates = capabilities.filter(
      (candidate) =>
        candidate.definition.kind === "skill" &&
        candidate.managedBy !== "system" &&
        normalizePragmaResourceName(candidate.definition.name) ===
          normalizePragmaResourceName(dependency.name),
    );
    if (candidates.length === 0) continue;
    const key = `skill\0${dependency.resourceRef}`;
    expectedKeys.add(key);
    const resolution = resolutionByRef.get(key);
    if (resolution === undefined) {
      throw new Error(`Choose an import action for Skill ${dependency.name}.`);
    }
    if (resolution.action === "copy") continue;
    const target = candidates.find(
      (candidate) => candidate.manifest.id === resolution.targetAssetId,
    );
    const fingerprint =
      target === undefined
        ? undefined
        : dependency.assetFingerprint === undefined
          ? sha256(stableStringify(target.definition))
          : await input.localSkillAssetFingerprint(target);
    const importedFingerprint = dependency.assetFingerprint ?? dependency.definitionFingerprint;
    const alreadyApplied =
      input.allowAlreadyApplied &&
      resolution.action === "update" &&
      fingerprint === importedFingerprint;
    if (
      target === undefined ||
      (!alreadyApplied &&
        (resolution.expectedTarget?.revision !== target.manifest.latestRevision ||
          resolution.expectedTarget?.fingerprint !== fingerprint))
    ) {
      throw new Error(
        `The target Skill changed after inspection: ${dependency.name}. Inspect the Bundle again.`,
      );
    }
  }
  for (const dependency of input.archive.manifest.dependencies.contextStores) {
    if (!dependency.included || dependency.fingerprint === undefined) continue;
    const candidates = stores.filter(
      (candidate) =>
        normalizePragmaResourceName(candidate.name) ===
        normalizePragmaResourceName(dependency.name),
    );
    if (candidates.length === 0) continue;
    const key = `knowledge_base\0${dependency.resourceRef}`;
    const resolution = resolutionByRef.get(key);
    // An explicit resource update already selects its bound store and carries snapshot CAS.
    // Its own completed metadata write must not introduce a new name-based asset decision on replay.
    if (resolution === undefined && input.contextResourceUpdates?.has(dependency.resourceRef))
      continue;
    expectedKeys.add(key);
    if (resolution === undefined) {
      throw new Error(`Choose an import action for knowledge base ${dependency.name}.`);
    }
    if (resolution.action === "copy") continue;
    const target = candidates.find((candidate) => candidate.id === resolution.targetAssetId);
    const fingerprint =
      target === undefined
        ? undefined
        : knowledgeBaseAssetFingerprint({
            name: target.name,
            description: target.description,
            snapshotHash: target.snapshotHash,
          });
    const importedFingerprint = knowledgeBaseAssetFingerprint({
      name: dependency.name,
      description: dependency.description,
      snapshotHash: dependency.snapshot?.snapshotHash ?? dependency.fingerprint,
    });
    const alreadyApplied =
      input.allowAlreadyApplied &&
      resolution.action === "update" &&
      fingerprint === importedFingerprint;
    if (
      target === undefined ||
      (!alreadyApplied &&
        (resolution.expectedTarget?.revision !== target.contentRevision ||
          resolution.expectedTarget?.fingerprint !== fingerprint))
    ) {
      throw new Error(
        `The target knowledge base changed after inspection: ${dependency.name}. Inspect the Bundle again.`,
      );
    }
  }
  for (const key of resolutionByRef.keys()) {
    if (!expectedKeys.has(key)) {
      throw new Error("An asset conflict resolution does not match the inspected Bundle.");
    }
  }
  return resolutionByRef;
}

function bundleCapabilityAssetKey(dependency: {
  readonly logicalId?: string | undefined;
  readonly resourceRef: string;
}): string {
  return dependency.logicalId === undefined
    ? `resource:${dependency.resourceRef}`
    : `logical:${dependency.logicalId}`;
}

async function readDesktopBundle(
  sourcePath: string,
  requestedRootRef?: string,
  trustedInternalPath = false,
): Promise<DesktopBundleArchive> {
  if (!trustedInternalPath && !sourcePath.toLowerCase().endsWith(".pragma")) {
    throw new Error("Select a .pragma file.");
  }
  let decoded: DecodedPragmaBundle;
  try {
    decoded = await decodePragmaBundle({ kind: "file", path: sourcePath });
  } catch (error) {
    if (
      error instanceof PragmaBundleFormatError &&
      error.code === "manifest.version_unsupported" &&
      error.message.includes("pragma.desktop-bundle/v1")
    ) {
      throw new Error(
        "This legacy Desktop Bundle is no longer supported. Import it with Pragma Desktop v0.1.0, upgrade Pragma, then export it again.",
        { cause: error },
      );
    }
    throw error;
  }
  const project = await loadPragmaProject(
    { kind: "decoded-bundle", bundle: decoded },
    {
      supportedBundleExtensions: new Set(["pragma.desktop.flow-layout@v1"]),
    },
  );
  try {
    const allResources = project.listResources();
    const resourceByRef = new Map(
      allResources.map((resource) => [canonicalPragmaResourceRef(resource), resource] as const),
    );
    const roots = decoded.manifest.roots.map((ref) => {
      const resource = resourceByRef.get(ref);
      if (
        resource === undefined ||
        (resource.kind !== "Expert" &&
          resource.kind !== "ExpertTeam" &&
          resource.kind !== "Flow" &&
          resource.kind !== "ContextStore" &&
          resource.kind !== "Capability")
      ) {
        throw new Error(`Bundle root is unavailable: ${ref}.`);
      }
      return { ref, kind: resource.kind, name: resource.metadata.name };
    });
    const selectedRef = requestedRootRef ?? roots[0]?.ref;
    const root = roots.find((candidate) => candidate.ref === selectedRef);
    if (root === undefined) throw new Error(`Bundle root is unavailable: ${String(selectedRef)}.`);
    const resources = project.listResourceClosure(PragmaBundleRootRefSchema.parse(root.ref));
    const closureRefs = new Set(resources.map(canonicalPragmaResourceRef));
    const requirements = decoded.manifest.requirements.filter((requirement) =>
      closureRefs.has(requirement.ownerRef),
    );
    const files = new Map(decoded.files);
    const projectArtifacts = collectPragmaProjectArtifactPaths(resources);
    for (const artifactPath of projectArtifacts) {
      const prefix = `project/${artifactPath.replace(/\/+$/, "")}`;
      for (const [path, contents] of decoded.files) {
        if (path === prefix || path.startsWith(`${prefix}/`)) {
          files.set(path.slice("project/".length), contents);
        }
      }
    }
    const layoutExtension = decoded.manifest.extensions.find(
      (extension) => `${extension.id}@${extension.version}` === "pragma.desktop.flow-layout@v1",
    );
    if (layoutExtension !== undefined) {
      for (const [path, contents] of filesBelowPrefix(decoded.files, layoutExtension.root)) {
        files.set(`layouts/flows/${path}`, contents);
      }
    }
    const capabilities = [];
    const contextStores = [];
    const plugins = [];
    const runtimes = [];
    const secrets = [];
    const unsupported = [];
    for (const requirement of requirements) {
      const owner = resourceByRef.get(requirement.ownerRef);
      const payloadFiles =
        requirement.payload === undefined
          ? new Map<string, Uint8Array>()
          : filesBelowPrefix(decoded.files, requirement.payload.root);
      if (requirement.kind === "binding" && owner?.kind === "Capability") {
        const skill =
          requirement.payload?.codec === "pragma.skill@v1"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                SkillBundlePayloadDescriptorSchema,
                `Skill descriptor ${requirement.id}`,
              )
            : undefined;
        if (skill !== undefined) {
          assertValidSkillBundlePayload({
            descriptor: skill,
            files: payloadFiles,
            sha256,
            label: requirement.id,
          });
        }
        const v3 =
          requirement.payload?.codec === "pragma.desktop.capability@v3"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                DesktopCapabilityPayloadDescriptorV3Schema,
                `Capability descriptor ${requirement.id}`,
              )
            : undefined;
        const v2 =
          requirement.payload?.codec === "pragma.desktop.capability@v2"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                DesktopCapabilityPayloadDescriptorV2Schema,
                `Capability descriptor ${requirement.id}`,
              )
            : undefined;
        const included =
          skill !== undefined ||
          requirement.payload?.codec === "pragma.desktop.capability@v1" ||
          v2 !== undefined ||
          v3 !== undefined;
        const definition =
          (skill === undefined
            ? undefined
            : CapabilityDefinitionSchema.parse({
                kind: "skill",
                name: skill.name,
                description: skill.description,
                entryPath: skill.entryPath,
                contentHash: skill.contentHash,
              })) ??
          v3?.definition ??
          v2?.definition ??
          (requirement.payload?.codec === "pragma.desktop.capability@v1"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                CapabilityDefinitionSchema,
                `Capability descriptor ${requirement.id}`,
              )
            : undefined);
        if (skill !== undefined && definition === undefined) {
          throw new Error(`Skill payload definition is missing: ${requirement.id}.`);
        }
        capabilities.push({
          requirementId: requirement.id,
          resourceRef: requirement.ownerRef,
          name: definition?.name ?? owner.metadata.name,
          ...(definition === undefined
            ? {}
            : {
                kind: definition.kind,
                definition,
                definitionFingerprint: sha256(stableStringify(definition)),
                ...(skill === undefined || definition.kind !== "skill"
                  ? {}
                  : {
                      assetFingerprint: skillAssetFingerprint(definition, skill.filesFingerprint),
                    }),
              }),
          ...(skill !== undefined
            ? { logicalId: skill.assetKey }
            : v3 !== undefined
              ? { logicalId: v3.assetKey }
              : v2 !== undefined
                ? {
                    logicalId: v2.logicalId,
                    sourceRevision: v2.revision,
                    ...(v2.revisions === undefined ? {} : { history: v2.revisions }),
                  }
                : {}),
          included,
          ...(requirement.payload === undefined ? {} : { payloadRoot: requirement.payload.root }),
          ...(requirement.payload === undefined ? {} : { payloadCodec: requirement.payload.codec }),
          ...(skill === undefined ? {} : { skillFiles: skill.files }),
        });
      } else if (requirement.kind === "binding" && owner?.kind === "ContextStore") {
        const v4 =
          requirement.payload?.codec === "pragma.desktop.context-store@v4"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                DesktopContextPayloadDescriptorV4Schema,
                `ContextStore descriptor ${requirement.id}`,
              )
            : undefined;
        const v3 =
          requirement.payload?.codec === "pragma.desktop.context-store@v3"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                DesktopContextPayloadDescriptorV3Schema,
                `ContextStore descriptor ${requirement.id}`,
              )
            : undefined;
        const v2 =
          requirement.payload?.codec === "pragma.desktop.context-store@v2"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                DesktopContextPayloadDescriptorV2Schema,
                `ContextStore descriptor ${requirement.id}`,
              )
            : undefined;
        const metadata =
          v4 ??
          v3 ??
          v2 ??
          (requirement.payload?.codec === "pragma.desktop.context-store@v1"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                DesktopContextPayloadDescriptorSchema,
                `ContextStore descriptor ${requirement.id}`,
              )
            : undefined);
        const included =
          requirement.payload?.codec === "pragma.desktop.context-store@v1" ||
          (v2?.contentIncluded ?? false) ||
          (v3?.contentIncluded ?? false) ||
          (v4?.contentIncluded ?? false);
        const snapshot =
          v4?.snapshot === undefined
            ? v3?.snapshot
            : ContextStoreSnapshotSchema.parse({
                ...v4.snapshot,
                files: v4.snapshot.files.map((file) => ({
                  ...file,
                  content: new TextDecoder().decode(
                    requiredBundlePayloadFile(payloadFiles, `files/${file.id}`, requirement.id),
                  ),
                })),
              });
        if (v4?.snapshot !== undefined) {
          const declaredFiles = new Set(v4.snapshot.files.map((file) => `files/${file.id}`));
          for (const path of payloadFiles.keys()) {
            if (path !== "descriptor.json" && !declaredFiles.has(path)) {
              throw new Error(
                `ContextStore payload ${requirement.id} contains an undeclared file: ${path}.`,
              );
            }
          }
        }
        contextStores.push({
          requirementId: requirement.id,
          resourceRef: requirement.ownerRef,
          name: metadata?.name ?? owner.metadata.name,
          description: metadata?.description ?? owner.metadata.description,
          ...(metadata === undefined ? {} : { fingerprint: metadata.fingerprint }),
          ...(v2 === undefined
            ? {}
            : { sourceId: v2.sourceId, contentIncluded: v2.contentIncluded }),
          ...(v4 !== undefined
            ? { contentIncluded: v4.contentIncluded }
            : v3 === undefined
              ? {}
              : { contentIncluded: v3.contentIncluded }),
          ...(snapshot === undefined ? {} : { snapshot }),
          included,
          ...(requirement.payload === undefined || !included || v3 !== undefined || v4 !== undefined
            ? {}
            : { payloadRoot: `${requirement.payload.root}/files` }),
        });
      } else if (requirement.kind === "plugin") {
        plugins.push({
          requirementId: requirement.id,
          ownerRef: requirement.ownerRef,
          ref: requirement.contract,
          name: requirement.name,
          included: requirement.payload?.codec === "pragma.desktop.plugin@v1",
          ...(requirement.payload === undefined ? {} : { payloadRoot: requirement.payload.root }),
        });
      } else if (requirement.kind === "runtime" && owner?.kind === "RuntimeProfile") {
        const config =
          typeof owner.spec.config === "object" && owner.spec.config !== null
            ? (owner.spec.config as Record<string, unknown>)
            : {};
        runtimes.push({
          requirementId: requirement.id,
          resourceRef: requirement.ownerRef,
          name: owner.metadata.name,
          ...(typeof config["runtimeId"] === "string" ? { runtimeId: config["runtimeId"] } : {}),
          ...(typeof config["providerId"] === "string" ? { providerId: config["providerId"] } : {}),
          ...(typeof config["model"] === "string" ? { modelId: config["model"] } : {}),
          ...(typeof config["thinkingLevel"] === "string"
            ? { thinkingLevel: config["thinkingLevel"] }
            : {}),
        });
      } else if (requirement.kind === "secret") {
        secrets.push(requirement);
      } else {
        unsupported.push(requirement);
      }
    }
    if (root.kind === "ContextStore") {
      const rootPayload = contextStores.find((dependency) => dependency.resourceRef === root.ref);
      if (rootPayload?.included !== true || rootPayload.snapshot === undefined) {
        throw new Error("A knowledge-base root must include its current managed snapshot.");
      }
    }
    if (root.kind === "Capability") {
      const rootPayload = capabilities.find((dependency) => dependency.resourceRef === root.ref);
      if (
        rootPayload?.included !== true ||
        rootPayload.kind !== "skill" ||
        rootPayload.payloadCodec !== "pragma.skill@v1" ||
        rootPayload.payloadRoot === undefined
      ) {
        throw new Error("A Skill root must include its current pragma.skill@v1 payload.");
      }
    }
    return {
      sourceBytes: decoded.sourceBytes,
      bundle: decoded,
      manifest: {
        bundleFingerprint: decoded.manifest.bundleFingerprint,
        projectFingerprint: decoded.manifest.project.projectFingerprint,
        createdAt: decoded.manifest.createdAt,
        roots,
        root,
        projectArtifacts,
        dependencies: { capabilities, contextStores, plugins, runtimes, secrets, unsupported },
      },
      files,
      resources,
      archiveBytes: decoded.archiveBytes,
      fileCount: decoded.files.size,
      unpackedBytes: [...decoded.files.values()].reduce(
        (total, contents) => total + contents.byteLength,
        0,
      ),
    };
  } finally {
    await project.dispose();
  }
}

function buildInspectionReadiness(
  archive: DesktopBundleArchive,
  requirements: PragmaBundleImportInspection["requirements"],
): PragmaBundleDependencyReadiness[] {
  const byId = new Map<string, PragmaBundleDependencyReadiness>();
  for (const requirement of requirements) {
    byId.set(requirement.id, {
      id: requirement.id,
      kind: requirement.kind,
      resourceRef: requirement.resourceRef,
      name: requirement.name,
      status: "missing",
      code: `${requirement.kind.replaceAll("-", "_")}_missing`,
      action: inspectionAction(requirement.kind),
      message: requirement.message,
      ...(requirement.capabilityKind === undefined
        ? {}
        : { capabilityKind: requirement.capabilityKind }),
    });
  }
  const addReady = (item: {
    readonly id: string;
    readonly kind: PragmaBundleDependencyReadiness["kind"];
    readonly resourceRef: string;
    readonly name: string;
    readonly capabilityKind?: PragmaBundleDependencyReadiness["capabilityKind"];
  }) => {
    if (byId.has(item.id)) return;
    byId.set(item.id, {
      ...item,
      status: "ready",
      code: "ready",
      action: "none",
      message: "Dependency is ready.",
    });
  };
  for (const item of archive.manifest.dependencies.capabilities) {
    if (byId.has(item.requirementId)) continue;
    if (item.definition !== undefined && capabilityNeedsCredentials(item.definition)) {
      byId.set(item.requirementId, {
        id: item.requirementId,
        kind: "capability",
        resourceRef: item.resourceRef,
        name: item.name,
        status: "action_required",
        code: "capability_credentials_required",
        action: "configure_capability",
        message: "Configure this capability before using the imported Bundle.",
        capabilityKind: item.definition.kind,
      });
      continue;
    }
    addReady({
      id: item.requirementId,
      kind: "capability",
      resourceRef: item.resourceRef,
      name: item.name,
      ...(item.kind === undefined ? {} : { capabilityKind: item.kind }),
    });
  }
  for (const item of archive.manifest.dependencies.contextStores) {
    addReady({
      id: item.requirementId,
      kind: "context-store",
      resourceRef: item.resourceRef,
      name: item.name,
    });
  }
  for (const item of archive.manifest.dependencies.plugins) {
    addReady({
      id: item.requirementId,
      kind: "plugin",
      resourceRef: item.ref,
      name: item.name,
    });
  }
  for (const item of archive.manifest.dependencies.runtimes) {
    addReady({
      id: item.requirementId,
      kind: "runtime",
      resourceRef: item.resourceRef,
      name: item.name,
    });
  }
  for (const item of archive.manifest.dependencies.secrets) {
    addReady({
      id: item.id,
      kind: "secret",
      resourceRef: item.ownerRef,
      name: item.name,
    });
  }
  return [...byId.values()];
}

function readinessFromPending(
  dependency: PragmaBundleInstallation["pending"][number],
): PragmaBundleDependencyReadiness {
  return {
    id: dependency.id,
    kind: dependency.kind,
    resourceRef: dependency.resourceRef,
    name: dependency.name,
    status: dependency.status ?? "action_required",
    code: dependency.code ?? "legacy_pending",
    action: dependency.action ?? "restore_or_replace",
    message: dependency.message,
    ...(dependency.capabilityKind === undefined
      ? {}
      : { capabilityKind: dependency.capabilityKind }),
    ...(dependency.targetId === undefined ? {} : { targetId: dependency.targetId }),
  };
}

function mergeReadiness(
  primary: readonly PragmaBundleDependencyReadiness[],
  secondary: readonly PragmaBundleDependencyReadiness[],
): PragmaBundleDependencyReadiness[] {
  const byId = new Map(primary.map((dependency) => [dependency.id, dependency]));
  const byScope = new Map(
    primary.map((dependency) => [`${dependency.kind}\0${dependency.resourceRef}`, dependency]),
  );
  for (const dependency of secondary) {
    if (byId.has(dependency.id) || byScope.has(`${dependency.kind}\0${dependency.resourceRef}`)) {
      continue;
    }
    byId.set(dependency.id, dependency);
  }
  return [...byId.values()];
}

function inspectionAction(
  kind: PragmaBundleDependencyReadiness["kind"],
): PragmaBundleDependencyReadiness["action"] {
  switch (kind) {
    case "runtime":
      return "choose_runtime";
    case "capability":
      return "choose_capability";
    case "context-store":
      return "choose_knowledge_base";
    case "plugin":
      return "install_plugin";
    case "secret":
      return "enter_secret";
  }
}

function capabilityNeedsCredentials(
  definition: z.infer<typeof CapabilityDefinitionSchema>,
): boolean {
  if (definition.kind === "mcp_server") {
    return definition.connection.transport === "stdio"
      ? Object.keys(definition.connection.secretEnv).length > 0
      : definition.connection.tokenCredentialRef !== undefined;
  }
  return definition.kind === "http_service" && definition.auth.type !== "none";
}

function sha256(value: string | Uint8Array | readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  if (typeof value === "string" || value instanceof Uint8Array) hash.update(value);
  else for (const chunk of value) hash.update(chunk);
  return hash.digest("hex");
}

function skillAssetFingerprint(
  definition: {
    readonly name: string;
    readonly description: string;
    readonly entryPath: "SKILL.md";
  },
  filesFingerprint: string,
): string {
  return sha256(
    serializeSkillBundleAssetIdentity({
      name: definition.name,
      description: definition.description,
      entryPath: definition.entryPath,
      filesFingerprint,
    }),
  );
}

function knowledgeBaseAssetFingerprint(input: {
  readonly name: string;
  readonly description: string;
  readonly snapshotHash: string;
}): string {
  return sha256(stableStringify(input));
}

async function rewriteSkillName(root: string, name: string): Promise<void> {
  const path = join(root, "SKILL.md");
  const source = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
  if (!source.startsWith("---\n")) {
    throw new Error("The imported Skill is missing YAML frontmatter.");
  }
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("The imported Skill has invalid YAML frontmatter.");
  const frontmatter = parseYaml(source.slice(4, end)) as unknown;
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new Error("The imported Skill has invalid YAML frontmatter.");
  }
  await writeFile(
    path,
    `---\n${stringifyYaml({ ...frontmatter, name }).trimEnd()}\n---\n${source.slice(end + 5)}`,
    "utf8",
  );
}

function formatRevisionDirectory(revision: number): string {
  return revision.toString().padStart(6, "0");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredBundlePayloadFile(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  requirementId: string,
): Uint8Array {
  const contents = files.get(path);
  if (contents === undefined) {
    throw new Error(`Bundle payload ${requirementId} is missing ${path}.`);
  }
  return contents;
}

function parseBundlePayloadJson<TSchema extends z.ZodType>(
  contents: Uint8Array,
  schema: TSchema,
  label: string,
): z.infer<TSchema> {
  let value: unknown;
  try {
    value = JSON.parse(strFromU8(contents)) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${label} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function materializePrefix(
  files: ReadonlyMap<string, Uint8Array>,
  prefix: string,
  temporaryPrefix: string,
  executablePaths: ReadonlySet<string> = new Set(),
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), temporaryPrefix));
  for (const [path, contents] of filesBelowPrefix(files, prefix)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, contents, { mode: executablePaths.has(path) ? 0o700 : 0o600 });
  }
  return root;
}

function filesBelowPrefix(
  files: ReadonlyMap<string, Uint8Array>,
  prefix: string,
): Map<string, Uint8Array> {
  const normalizedPrefix = `${prefix.replace(/\/+$/, "")}/`;
  return new Map(
    [...files].flatMap(([path, contents]) =>
      path.startsWith(normalizedPrefix)
        ? [[path.slice(normalizedPrefix.length), contents] as const]
        : [],
    ),
  );
}

function uniqueMatch<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function installationErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_.-]{0,199}$/.test(error.code)
  )
    return error.code;
  return "installation_failed";
}

function rebindRuntimeConfig(
  previous: unknown,
  resolution: {
    readonly runtimeId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly thinkingLevel?: string | undefined;
  },
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...(typeof previous === "object" && previous !== null && !Array.isArray(previous)
      ? previous
      : {}),
    runtimeId: resolution.runtimeId,
    providerId: resolution.providerId,
    model: resolution.modelId,
  };
  if (resolution.thinkingLevel === undefined) delete result["thinkingLevel"];
  else result["thinkingLevel"] = resolution.thinkingLevel;
  return result;
}
