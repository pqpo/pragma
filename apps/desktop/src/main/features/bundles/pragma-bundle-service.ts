import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  PRAGMA_MANAGEMENT_CAPABILITY_REF,
  pragmaManagementCapabilityResource,
} from "@pragma/built-in-agents";

import {
  PragmaPaths,
  applyAtomicStateMigration,
  bundleInstallationsMigrationChain,
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
  remapPragmaProjectArtifactPaths,
  type DecodedPragmaBundle,
  type PragmaBundleRequirement,
} from "@pragma/interpreter";
import {
  PragmaBundleRootRefSchema,
  PragmaForwardCompatibleResourceSchema,
  PragmaInvocableResourceRefSchema,
  canonicalPragmaResourceRef,
  type PragmaInvocableResource,
  type PragmaResource,
  type PragmaResourceRef,
} from "@pragma/interpreter/ast";
import { strFromU8, zipSync } from "fflate";
import { z } from "zod";

import {
  CreateCapabilitySchema,
  CapabilityDefinitionSchema,
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
  type ResolvePragmaBundleInstallation,
  type StartPragmaBundleImport,
  type DesktopRuntimeAvailability,
} from "../../../shared/contracts/index.ts";
import {
  bindExistingDesktopCapabilityResource,
  bindExistingDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import {
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";
import { CapabilityStoreError, type CapabilityStore } from "../capabilities/capability-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import { writeBundleAtomically } from "./pragma-bundle-file.ts";
import {
  assertPortablePluginConfigs,
  assertUniqueResolutionRefs,
  collectCapabilities,
  collectContexts,
  collectPlugins,
  inspectBundleReadiness,
  isPortableValue,
  mergePendingMetadata,
  pendingBinding,
  readinessToPending,
  runtimeDependencyAvailable,
  unique,
} from "./pragma-bundle-dependencies.ts";
import {
  artifactPathIsReferenced,
  findBundleConflicts,
  isBundleOwnedArtifact,
  resolveBundleIdentities,
} from "./pragma-bundle-resources.ts";

const InstallationCatalogSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-installations/v5"),
    installations: z.array(PragmaBundleInstallationSchema),
  })
  .strict();

type DesktopProjectSnapshot = Awaited<ReturnType<PragmaProjectStore["get"]>>;

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
    logicalId: z.string().uuid(),
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
  left: readonly { readonly resourceRef: string; readonly action: "update" | "copy" }[],
  right: readonly { readonly resourceRef: string; readonly action: "update" | "copy" }[],
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
  inspect(sourcePath: string, rootRef?: string): Promise<PragmaBundleImportInspection>;
  startImport(input: StartPragmaBundleImport): Promise<PragmaBundleInstallation>;
  listInstallations(): Promise<readonly PragmaBundleInstallation[]>;
  recheckInstallation(installationId: string): Promise<PragmaBundleInstallation>;
  resolveInstallation(input: ResolvePragmaBundleInstallation): Promise<PragmaBundleInstallation>;
  discardInstallation(installationId: string): Promise<void>;
  getReadinessForRef(ref: string): Promise<readonly PragmaBundleDependencyReadiness[]>;
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
        return { schemaVersion: "pragma.bundle-installations/v5", installations: [] };
      }
      throw error;
    }
  };
  let initialization: Promise<void> | undefined;

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
        "The previous import was interrupted. Import the bundle again to retry safely, or discard this installation.",
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
    let store = (await options.contextStores.list()).find(
      (candidate) => candidate.id === update.storeId,
    );
    if (store === undefined) {
      if (update.baseRevision !== undefined || update.baseSnapshotHash !== undefined) {
        throw new Error("The knowledge base targeted by the interrupted import is unavailable.");
      }
      store = await options.contextStores.createFromSnapshot({
        id: update.storeId,
        name: dependency.name,
        description: dependency.description,
        directories: dependency.snapshot.directories,
        files: dependency.snapshot.files,
        author: "import",
        summary: "Recover interrupted knowledge-base Bundle import.",
      });
    } else {
      const snapshot = await options.contextStores.getSnapshot(store.id);
      if (snapshot.snapshotHash !== update.importedSnapshotHash) {
        if (
          snapshot.revision !== update.baseRevision ||
          snapshot.snapshotHash !== update.baseSnapshotHash
        ) {
          throw new Error(
            "The target knowledge base changed after an interrupted import. Inspect the Bundle again.",
          );
        }
        await options.contextStores.appendSnapshot(
          {
            storeId: store.id,
            baseRevision: snapshot.revision,
            baseSnapshotHash: snapshot.snapshotHash,
            snapshotHash: dependency.snapshot.snapshotHash,
            directories: dependency.snapshot.directories,
            files: dependency.snapshot.files,
            summary: "Recover interrupted knowledge-base Bundle import.",
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
        InstallationCatalogSchema.parse(documents[catalogFile]);
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
    const interrupted = (await readCatalogFile()).installations.filter(
      (installation) => installation.status === "installing",
    );
    await Promise.all(
      interrupted.map(async (installation) => {
        try {
          await recoverKnowledgeBaseInstallation(installation);
        } catch (error) {
          await updateInstallationFile(installation.id, (current) => ({
            ...current,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            updatedAt: new Date().toISOString(),
          }));
        }
      }),
    );
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
    const project = await options.project.openRevision(projectRevision);
    try {
      const resources = project.listResourceClosure(PragmaBundleRootRefSchema.parse(rootRef));
      const root = resources.find(
        (
          resource,
        ): resource is Extract<
          PragmaResource,
          { kind: "Expert" | "ExpertTeam" | "Flow" | "ContextStore" }
        > =>
          canonicalPragmaResourceRef(resource) === rootRef &&
          (resource.kind === "Expert" ||
            resource.kind === "ExpertTeam" ||
            resource.kind === "Flow" ||
            resource.kind === "ContextStore"),
      );
      if (root === undefined) throw new Error(`Bundle root not found: ${rootRef}`);
      const capabilities = await collectCapabilities(resources, options.capabilities);
      const contexts = await collectContexts(resources, options.contextStores);
      const plugins = await collectPlugins(resources, options.plugins);
      await assertPortablePluginConfigs(resources, plugins, options.plugins);
      const flows = resources.filter((resource) => resource.kind === "Flow");
      return {
        snapshot,
        project,
        root,
        resources,
        capabilities,
        contexts,
        plugins,
        flows,
      };
    } catch (error) {
      await project.dispose();
      throw error;
    }
  };

  const evaluateInstallation = async (
    installation: PragmaBundleInstallation,
    snapshot: DesktopProjectSnapshot,
    checkContextContent = true,
  ): Promise<{
    readonly readiness: PragmaBundleInstallation["readiness"];
    readonly pending: PragmaBundleInstallation["pending"];
  }> => {
    const resources = snapshot.resources.filter((resource) =>
      installation.resourceRefs.includes(canonicalPragmaResourceRef(resource)),
    );
    const readiness = await inspectBundleReadiness(resources, {
      capabilities: options.capabilities,
      contextStores: options.contextStores,
      plugins: options.plugins,
      runtimes: await options.getRuntimes(),
      checkContextContent,
    });
    const secretReadiness = await Promise.all(
      (installation.readiness.filter((dependency) => dependency.kind === "secret").length > 0
        ? installation.readiness.filter((dependency) => dependency.kind === "secret")
        : installation.pending.filter((dependency) => dependency.kind === "secret")
      ).map(async (dependency): Promise<PragmaBundleDependencyReadiness> => {
        const available = await options.plugins.hasSecret(`binding:pragma.bundle.${dependency.id}`);
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
      projectRevision: snapshot.revision,
      status: evaluated.pending.length === 0 ? "ready" : "needs_setup",
      pending: evaluated.pending,
      readiness: evaluated.readiness,
      error: undefined,
      updatedAt: new Date().toISOString(),
    }));
    if (updated.status === "ready") await cleanupInstallationArchive(updated.id);
    return updated;
  };

  const discardCreatedInstallation = async (
    installation: PragmaBundleInstallation,
  ): Promise<void> => {
    if (installation.createdResourceRefs.length !== installation.resourceRefs.length) {
      throw new Error(
        "This import changed existing project resources. Automatic rollback would overwrite later work, so import it as a copy or restore the project explicitly.",
      );
    }
    const snapshot = await options.project.get();
    const createdRefs = new Set(installation.createdResourceRefs);
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
    for (const id of installation.createdContextStoreIds) await options.contextStores.remove(id);
    for (const id of installation.createdCapabilityIds) await options.capabilities.remove(id);
    await removeInstallationRecord(installation.id);
  };

  return {
    async initialize() {
      await ensureInitialized();
    },

    async prepareExport(input) {
      const prepared = await prepare(input.rootRef, input.projectRevision);
      try {
        return PragmaBundleExportPreviewSchema.parse({
          root: {
            ref: canonicalPragmaResourceRef(prepared.root),
            kind: prepared.root.kind,
            name: prepared.root.metadata.name,
          },
          projectRevision: prepared.snapshot.revision,
          resourceCount: prepared.resources.length,
          capabilityCount: prepared.capabilities.length,
          pluginCount: prepared.plugins.length,
          knowledgeBaseCount: prepared.contexts.length,
          hasFlowLayouts: prepared.flows.length > 0,
          defaults: {
            capabilities: true,
            plugins: true,
            knowledgeBases: prepared.root.kind === "ContextStore",
            flowLayouts: true,
          },
        });
      } finally {
        await prepared.project.dispose();
      }
    },

    async exportTo(input, destinationPath) {
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
        const pluginByRef = new Map(prepared.plugins.map((entry) => [entry.ref, entry]));
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
                if (resource?.kind === "Capability" && input.modules.capabilities) {
                  const entry = capabilityByRef.get(requirement.ownerRef);
                  if (entry?.capability === undefined || originalBindingRef === undefined) {
                    return undefined;
                  }
                  if (!isPortableValue(entry.capability.definition)) return undefined;
                  const binding = parseDesktopCapabilityBindingRef(
                    entry.resource.spec.binding ?? "",
                  );
                  const sourceRevision =
                    binding?.revision ?? entry.capability.manifest.latestRevision;
                  const logicalId =
                    entry.capability.manifest.origin?.logicalId ?? entry.capability.manifest.id;
                  const revisionHistory = await Promise.all(
                    Array.from({ length: sourceRevision }, async (_, index) => {
                      const revision = index + 1;
                      const historical = await options.capabilities.get(
                        entry.capability!.manifest.id,
                        revision,
                      );
                      if (!isPortableValue(historical.definition)) {
                        throw new Error(
                          `Capability revision ${revision} is not portable: ${entry.capability!.manifest.name}.`,
                        );
                      }
                      return { revision, definition: historical.definition };
                    }),
                  );
                  const sourceDefinition = revisionHistory.at(-1)?.definition;
                  if (sourceDefinition === undefined) return undefined;
                  const files = new Map<string, Uint8Array>([
                    [
                      "descriptor.json",
                      new TextEncoder().encode(
                        `${JSON.stringify(
                          {
                            schemaVersion: "pragma.desktop.capability-descriptor/v2",
                            logicalId,
                            revision: sourceRevision,
                            definition: sourceDefinition,
                            revisions: revisionHistory,
                          },
                          null,
                          2,
                        )}\n`,
                      ),
                    ],
                  ]);
                  if (sourceDefinition.kind === "skill") {
                    await addDirectoryFiles(
                      files,
                      await options.capabilities.skillFilesPath(
                        entry.capability.manifest.id,
                        sourceRevision,
                      ),
                      "files",
                    );
                    for (const revision of revisionHistory) {
                      await addDirectoryFiles(
                        files,
                        await options.capabilities.skillFilesPath(
                          entry.capability.manifest.id,
                          revision.revision,
                        ),
                        `history/${formatRevisionDirectory(revision.revision)}`,
                      );
                    }
                  }
                  return { codec: "pragma.desktop.capability@v2", files };
                }
                if (resource?.kind === "ContextStore") {
                  const entry = contextByRef.get(requirement.ownerRef);
                  if (entry?.store === undefined || originalBindingRef === undefined)
                    return undefined;
                  const snapshot = includeKnowledgeBases
                    ? await options.contextStores.getSnapshot(entry.store.id)
                    : undefined;
                  const files = new Map<string, Uint8Array>([
                    [
                      "descriptor.json",
                      new TextEncoder().encode(
                        `${JSON.stringify(
                          {
                            schemaVersion: "pragma.desktop.context-store-descriptor/v3",
                            name: entry.store.name,
                            description: entry.store.description,
                            fingerprint: await options.contextStores.fingerprint(entry.store.id),
                            contentIncluded: includeKnowledgeBases,
                            ...(snapshot === undefined ? {} : { snapshot }),
                          },
                          null,
                          2,
                        )}\n`,
                      ),
                    ],
                  ]);
                  return { codec: "pragma.desktop.context-store@v3", files };
                }
                return undefined;
              }
              if (requirement.kind === "plugin" && input.modules.plugins) {
                const entry = pluginByRef.get(requirement.contract);
                if (entry?.packageInfo?.origin !== "user") return undefined;
                const files = new Map<string, Uint8Array>();
                await addDirectoryFiles(
                  files,
                  entry.packageInfo.root,
                  "",
                  new Set([".pragma-install.json"]),
                );
                return { codec: "pragma.desktop.plugin@v1", files };
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
        await prepared.project.dispose();
      }
    },

    async inspect(sourcePath, rootRef) {
      const archive = await readDesktopBundle(sourcePath, rootRef);
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
      const requirements: PragmaBundleImportInspection["requirements"] = [];
      for (const dependency of archive.manifest.dependencies.capabilities) {
        if (dependency.resourceRef === PRAGMA_MANAGEMENT_CAPABILITY_REF) continue;
        const exact =
          dependency.definitionFingerprint === undefined
            ? undefined
            : capabilities.find(
                (candidate) =>
                  sha256(stableStringify(candidate.definition)) ===
                  dependency.definitionFingerprint,
              );
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
            : contextStores.find(
                (store) => contextFingerprints.get(store.id) === dependency.fingerprint,
              );
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
        if (runtimes.some((runtime) => runtimeDependencyAvailable(runtime, dependency))) continue;
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
          message: `Desktop does not support required Bundle dependency ${dependency.contract}.`,
          required: true,
        });
      }
      const installations = (await readCatalog()).installations;
      const incompleteInstallation = findIncompleteInstallation(
        installations,
        archive.manifest.bundleFingerprint,
        archive.manifest.root.ref,
      );
      const readiness = buildInspectionReadiness(archive, requirements);
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

    async startImport(input) {
      const archive = await readDesktopBundle(input.sourcePath, input.rootRef);
      const unsupportedRequirement = archive.manifest.dependencies.unsupported.find(
        (requirement) => requirement.required,
      );
      if (unsupportedRequirement !== undefined) {
        throw new Error(
          `Desktop cannot install required Bundle dependency ${unsupportedRequirement.contract} (${unsupportedRequirement.id}).`,
        );
      }
      if (archive.manifest.bundleFingerprint !== input.expectedFingerprint) {
        throw new Error("The bundle changed after inspection. Inspect it again before importing.");
      }
      if (archive.manifest.projectFingerprint !== input.expectedProjectFingerprint) {
        throw new Error(
          "The portable project changed after inspection. Inspect it again before importing.",
        );
      }
      return await withFileLock(
        options.paths.bundleImportLock(archive.manifest.bundleFingerprint),
        async () => {
          const catalog = await readCatalog();
          const existing = findIncompleteInstallation(
            catalog.installations,
            archive.manifest.bundleFingerprint,
            archive.manifest.root.ref,
          );
          if (existing?.status === "needs_setup") return existing;
          if (existing !== undefined) {
            if (existing.createdResourceRefs.length === existing.resourceRefs.length) {
              await discardCreatedInstallation(existing);
            } else {
              const canRetryLegacyUpdate =
                existing.conflictResolutions.length === 0 &&
                input.conflicts.some((resolution) => resolution.action === "update");
              if (
                !canRetryLegacyUpdate &&
                !sameConflictResolutions(existing.conflictResolutions, input.conflicts)
              ) {
                throw new Error(
                  "The previous import changed existing resources. Retry it with the same update decisions.",
                );
              }
              await removeInstallationRecord(existing.id);
            }
          }
          const current = await options.project.get();
          if (current.revision !== input.expectedProjectRevision) {
            throw new Error("The project changed. Inspect the Bundle again before importing.");
          }
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
          const identityResolution = resolveBundleIdentities(
            archive.resources.filter((resource) => !isPragmaManagementCapability(resource)),
            current.resources,
            input.conflicts,
          );
          const localized = localizePragmaBundleResources({
            resources: archive.resources,
            manifest: archive.bundle.manifest,
            identities: identityResolution.identities,
          });
          const installationId = randomUUID();
          const archivePath = options.paths.bundleInstallationArchive(installationId);
          await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
          await writeBundleAtomically(
            archivePath,
            new Uint8Array(await readFile(input.sourcePath)),
          );
          const timestamp = new Date().toISOString();
          const initial = PragmaBundleInstallationSchema.parse({
            schemaVersion: "pragma.bundle-installation/v5",
            bundleVersion: "pragma.bundle/v2",
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
            conflictResolutions: input.conflicts,
            resourceMappings: [],
            status: "installing",
            pending: [],
            readiness: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          await addInstallation(initial);
          try {
            let resources = localized.resources.map((resource) =>
              isPragmaManagementCapability(resource)
                ? pragmaManagementCapabilityResource()
                : resource,
            );
            const sourceToTarget = localized.resourceMappings;
            const importedRefs = new Set(resources.map(canonicalPragmaResourceRef));
            const currentRefs = new Set(current.resources.map(canonicalPragmaResourceRef));
            const createdResourceRefs = [...importedRefs].filter((ref) => !currentRefs.has(ref));
            const rootRef =
              sourceToTarget.get(archive.manifest.root.ref) ?? archive.manifest.root.ref;
            await updateInstallation(initial.id, (record) => ({
              ...record,
              rootRef,
              resourceRefs: [...importedRefs],
              createdResourceRefs,
              conflictResolutions: input.conflicts,
              resourceMappings: [...sourceToTarget].map(([sourceRef, targetRef]) => ({
                sourceRef,
                targetRef,
              })),
              updatedAt: new Date().toISOString(),
            }));
            const pending: PragmaBundleInstallation["pending"] = [];

            const bundleCapabilityGroups = new Map<
              string,
              (typeof archive.manifest.dependencies.capabilities)[number][]
            >();
            for (const dependency of archive.manifest.dependencies.capabilities) {
              if (
                dependency.logicalId === undefined ||
                dependency.sourceRevision === undefined ||
                dependency.definition === undefined ||
                !dependency.included
              ) {
                continue;
              }
              const group = bundleCapabilityGroups.get(dependency.logicalId) ?? [];
              group.push(dependency);
              bundleCapabilityGroups.set(dependency.logicalId, group);
            }
            const importedBundleCapabilities = new Map<
              string,
              Awaited<ReturnType<CapabilityStore["get"]>>
            >();
            for (const [logicalId, group] of bundleCapabilityGroups) {
              const temporaryPayloads: string[] = [];
              try {
                const revisions: {
                  readonly revision: number;
                  readonly definition: z.infer<typeof CapabilityDefinitionSchema>;
                  readonly payloadPath?: string;
                }[] = [];
                const revisionsByNumber = new Map<number, (typeof revisions)[number]>();
                for (const dependency of group) {
                  const history =
                    dependency.history ??
                    (dependency.sourceRevision === undefined || dependency.definition === undefined
                      ? []
                      : [
                          {
                            revision: dependency.sourceRevision,
                            definition: dependency.definition,
                          },
                        ]);
                  for (const historical of history) {
                    const existing = revisionsByNumber.get(historical.revision);
                    if (existing !== undefined) {
                      if (
                        stableStringify(existing.definition) !==
                        stableStringify(historical.definition)
                      ) {
                        throw new CapabilityStoreError(
                          "bundle_identity_conflict",
                          `Capability revision ${historical.revision} conflicts inside the Bundle.`,
                        );
                      }
                      continue;
                    }
                    let payloadPath: string | undefined;
                    if (historical.definition.kind === "skill") {
                      if (dependency.payloadRoot === undefined) {
                        throw new Error(`Capability payload is incomplete: ${dependency.name}.`);
                      }
                      const historyPrefix = `${dependency.payloadRoot}/history/${formatRevisionDirectory(historical.revision)}`;
                      const currentPrefix = `${dependency.payloadRoot}/files`;
                      const prefix =
                        filesBelowPrefix(archive.files, historyPrefix).size > 0
                          ? historyPrefix
                          : historical.revision === dependency.sourceRevision &&
                              filesBelowPrefix(archive.files, currentPrefix).size > 0
                            ? currentPrefix
                            : undefined;
                      if (prefix === undefined) {
                        throw new Error(
                          `Capability payload is incomplete: ${dependency.name} revision ${historical.revision}.`,
                        );
                      }
                      payloadPath = await materializePrefix(
                        archive.files,
                        prefix,
                        "pragma-bundle-skill-revision-",
                      );
                      temporaryPayloads.push(payloadPath);
                    }
                    const revision = {
                      revision: historical.revision,
                      definition: historical.definition,
                      ...(payloadPath === undefined ? {} : { payloadPath }),
                    };
                    revisionsByNumber.set(historical.revision, revision);
                    revisions.push(revision);
                  }
                }
                revisions.sort((left, right) => left.revision - right.revision);
                const before = new Set(
                  (await options.capabilities.list()).map((capability) => capability.manifest.id),
                );
                const imported = await options.capabilities.importBundleRevisions({
                  logicalId,
                  revisions,
                });
                importedBundleCapabilities.set(logicalId, imported);
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

            for (const dependency of archive.manifest.dependencies.capabilities) {
              const targetRef =
                sourceToTarget.get(dependency.resourceRef) ?? dependency.resourceRef;
              const resource = resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              if (resource?.kind !== "Capability") continue;
              if (dependency.resourceRef === PRAGMA_MANAGEMENT_CAPABILITY_REF) continue;
              let capability =
                dependency.logicalId === undefined
                  ? undefined
                  : importedBundleCapabilities.get(dependency.logicalId);
              capability ??=
                dependency.definitionFingerprint === undefined
                  ? undefined
                  : (await options.capabilities.list()).find(
                      (candidate) =>
                        sha256(stableStringify(candidate.definition)) ===
                        dependency.definitionFingerprint,
                    );
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
                  capability = await options.capabilities.get(
                    resolution.capabilityId,
                    resolution.revision,
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
                  message: "Choose or install a compatible capability.",
                  ...(dependency.kind === undefined ? {} : { capabilityKind: dependency.kind }),
                });
              } else {
                const bindingRevision =
                  dependency.sourceRevision ?? capability.manifest.latestRevision;
                const capabilityAtBinding = await options.capabilities.get(
                  capability.manifest.id,
                  bindingRevision,
                );
                Object.assign(
                  resource,
                  bindExistingDesktopCapabilityResource(resource, {
                    id: capability.manifest.id,
                    revision: bindingRevision,
                  }),
                );
                if (capabilityAtBinding.health.status !== "ready") {
                  pending.push({
                    id: dependency.requirementId,
                    kind: "capability",
                    resourceRef: targetRef,
                    name: dependency.name,
                    message: "Complete capability setup before using this Bundle.",
                    capabilityKind: capabilityAtBinding.definition.kind,
                    status: "action_required",
                    code:
                      capabilityAtBinding.health.diagnostic?.code ?? "capability_needs_attention",
                    action: "configure_capability",
                    targetId: capability.manifest.id,
                  });
                }
              }
            }

            for (const dependency of archive.manifest.dependencies.contextStores) {
              const targetRef =
                sourceToTarget.get(dependency.resourceRef) ?? dependency.resourceRef;
              const resource = resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              if (resource?.kind !== "ContextStore") continue;
              const stores = await options.contextStores.list();
              const conflictAction = input.conflicts.find(
                (candidate) => candidate.resourceRef === dependency.resourceRef,
              );
              const currentResource = current.resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              const updateStoreId =
                conflictAction?.action === "update" && currentResource?.kind === "ContextStore"
                  ? parseDesktopContextBindingRef(currentResource.spec.binding ?? "")
                  : undefined;
              let store =
                updateStoreId === undefined
                  ? undefined
                  : stores.find((candidate) => candidate.id === updateStoreId);
              if (conflictAction?.action === "update" && store === undefined) {
                throw new Error(
                  `The matched knowledge base is not bound to an available managed Store: ${targetRef}.`,
                );
              }
              if (store !== undefined && dependency.snapshot !== undefined) {
                const currentSnapshot = await options.contextStores.getSnapshot(store.id);
                if (
                  conflictAction?.action === "update" &&
                  (conflictAction.expectedTargetRevision !== currentSnapshot.revision ||
                    conflictAction.expectedTargetSnapshotHash !== currentSnapshot.snapshotHash)
                ) {
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
                      phase: "prepared",
                    },
                    updatedAt: new Date().toISOString(),
                  }));
                }
                if (currentSnapshot.snapshotHash !== dependency.snapshot.snapshotHash) {
                  await options.contextStores.appendSnapshot(
                    {
                      storeId: store.id,
                      baseRevision: currentSnapshot.revision,
                      baseSnapshotHash: currentSnapshot.snapshotHash,
                      snapshotHash: dependency.snapshot.snapshotHash,
                      directories: dependency.snapshot.directories,
                      files: dependency.snapshot.files,
                      summary: "Append imported knowledge-base snapshot.",
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
              if (
                store === undefined &&
                dependency.fingerprint !== undefined &&
                archive.manifest.root.kind !== "ContextStore"
              ) {
                store = (
                  await Promise.all(
                    stores.map(async (candidate) => ({
                      candidate,
                      fingerprint: await options.contextStores.fingerprint(candidate.id),
                    })),
                  )
                ).find((candidate) => candidate.fingerprint === dependency.fingerprint)?.candidate;
              }
              if (store === undefined && dependency.snapshot !== undefined) {
                const importedStoreId = randomUUID();
                if (archive.manifest.root.kind === "ContextStore") {
                  await updateInstallation(initial.id, (record) => ({
                    ...record,
                    knowledgeBaseUpdate: {
                      sourceRef: dependency.resourceRef,
                      targetRef,
                      storeId: importedStoreId,
                      importedSnapshotHash: dependency.snapshot!.snapshotHash,
                      phase: "prepared",
                    },
                    updatedAt: new Date().toISOString(),
                  }));
                }
                store = await options.contextStores.createFromSnapshot({
                  id: importedStoreId,
                  name: dependency.name,
                  description: dependency.description,
                  directories: dependency.snapshot.directories,
                  files: dependency.snapshot.files,
                  author: "import",
                  summary: "Import current knowledge-base snapshot from a Pragma Bundle.",
                });
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
                  message: "Choose an existing knowledge base or import its Markdown files.",
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

            for (const dependency of archive.manifest.dependencies.plugins) {
              let installed = (await options.plugins.list()).find(
                (plugin) => plugin.ref === dependency.ref,
              );
              if (
                installed === undefined &&
                dependency.included &&
                dependency.payloadRoot !== undefined
              ) {
                const pluginFiles = filesBelowPrefix(archive.files, dependency.payloadRoot);
                const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-bundle-plugin-"));
                const pluginZip = join(temporaryRoot, "plugin.zip");
                try {
                  await writeFile(pluginZip, zipSync(Object.fromEntries(pluginFiles)), {
                    mode: 0o600,
                  });
                  const inspection = await options.plugins.inspectZip(pluginZip);
                  installed = await options.plugins.importZip({
                    sourcePath: pluginZip,
                    expectedHash: inspection.contentHash,
                  });
                  await updateInstallation(initial.id, (record) => ({
                    ...record,
                    createdPluginRefs: unique([...record.createdPluginRefs, installed!.ref]),
                    updatedAt: new Date().toISOString(),
                  }));
                } finally {
                  await rm(temporaryRoot, { recursive: true, force: true });
                }
              }
              if (installed === undefined) {
                const targetOwnerRef =
                  sourceToTarget.get(dependency.ownerRef) ?? dependency.ownerRef;
                pending.push({
                  id: dependency.requirementId,
                  kind: "plugin",
                  resourceRef: targetOwnerRef,
                  name: dependency.ref,
                  message: "Install the exact plugin package before running this workflow.",
                });
              }
            }

            const runtimes = await options.getRuntimes();
            for (const dependency of archive.manifest.dependencies.runtimes) {
              const targetRef =
                sourceToTarget.get(dependency.resourceRef) ?? dependency.resourceRef;
              const resource = resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              if (resource?.kind !== "RuntimeProfile") continue;
              const exact = runtimes.find((runtime) =>
                runtimeDependencyAvailable(runtime, dependency),
              );
              if (exact === undefined) {
                const resolution = input.runtimes.find(
                  (candidate) => candidate.resourceRef === dependency.resourceRef,
                );
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
                  resource.spec.config = {
                    runtimeId: resolution.runtimeId,
                    providerId: resolution.providerId,
                    model: resolution.modelId,
                    ...(resolution.thinkingLevel === undefined
                      ? {}
                      : { thinkingLevel: resolution.thinkingLevel }),
                  };
                }
              }
            }

            const secretById = new Map(
              archive.manifest.dependencies.secrets.map((requirement) => [
                requirement.id,
                requirement,
              ]),
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
              archive.manifest.dependencies.secrets.map(
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
            const combined = [
              ...current.resources.filter(
                (resource) => !importedRefs.has(canonicalPragmaResourceRef(resource)),
              ),
              ...resources,
            ];
            const referencedArtifacts = collectPragmaProjectArtifactPaths(combined);
            const retainedCurrentArtifacts = [...currentArtifacts].filter(
              ([path]) =>
                !isBundleOwnedArtifact(path) || artifactPathIsReferenced(path, referencedArtifacts),
            );
            const published = await options.project.publish({
              expectedRevision: current.revision,
              resources: combined,
              artifacts: new Map([...retainedCurrentArtifacts, ...importedArtifacts]),
            });
            await updateInstallation(initial.id, (record) => ({
              ...record,
              projectRevision: published.revision,
              resourceRefs: [...importedRefs],
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

            const verifiedReadiness = await inspectBundleReadiness(
              published.resources.filter((resource) =>
                importedRefs.has(canonicalPragmaResourceRef(resource)),
              ),
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
                resources.find((resource) => canonicalPragmaResourceRef(resource) === rootRef)
                  ?.metadata.name ?? record.rootName,
              resourceRefs: [...importedRefs],
              createdResourceRefs,
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
      const installation = (await readCatalog()).installations.find(
        (candidate) => candidate.id === installationId,
      );
      if (installation === undefined) throw new Error("Bundle installation not found.");
      return await recheck(installation);
    },

    async resolveInstallation(input) {
      const catalog = await readCatalog();
      const installation = catalog.installations.find(
        (candidate) => candidate.id === input.installationId,
      );
      if (installation === undefined) throw new Error("Bundle installation not found.");
      if (
        installation.projectId !== options.project.projectId ||
        installation.status !== "needs_setup"
      ) {
        throw new Error("This bundle installation is not awaiting setup.");
      }
      const snapshot = await options.project.get();
      if (snapshot.revision !== input.baseRevision) {
        throw new Error("The project changed. Reload bundle setup before saving.");
      }
      const pendingFor = (kind: string, resourceRef: string) =>
        installation.pending.find(
          (dependency) => dependency.kind === kind && dependency.resourceRef === resourceRef,
        );
      const requireImportedResource = (
        kind: "runtime" | "capability" | "context-store",
        resourceRef: PragmaResourceRef,
      ): PragmaResource => {
        if (
          !installation.resourceRefs.includes(resourceRef) ||
          pendingFor(kind, resourceRef) === undefined
        ) {
          throw new Error(`The requested ${kind} binding is not pending in this installation.`);
        }
        const resource = snapshot.resources.find(
          (candidate) => canonicalPragmaResourceRef(candidate) === resourceRef,
        );
        if (resource === undefined) {
          throw new Error(`Imported resource no longer exists: ${resourceRef}`);
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
              config: {
                runtimeId: resolution.runtimeId,
                providerId: resolution.providerId,
                model: resolution.modelId,
                ...(resolution.thinkingLevel === undefined
                  ? {}
                  : { thinkingLevel: resolution.thinkingLevel }),
              },
            },
          }),
        );
      }
      for (const resolution of input.capabilities) {
        const resource = requireImportedResource("capability", resolution.resourceRef);
        if (resource.kind !== "Capability") {
          throw new Error(`${resolution.resourceRef} is not a capability resource.`);
        }
        const capability = await options.capabilities.get(
          resolution.capabilityId,
          resolution.revision,
        );
        const requiredKind = pendingFor("capability", resolution.resourceRef)?.capabilityKind;
        if (requiredKind !== undefined && capability.definition.kind !== requiredKind) {
          throw new Error(`Choose a ${requiredKind} capability for ${resource.metadata.name}.`);
        }
        replacements.set(
          resolution.resourceRef,
          bindExistingDesktopCapabilityResource(resource, {
            id: resolution.capabilityId,
            revision: resolution.revision,
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
      if (replacements.size > 0) {
        await options.project.apply({
          baseRevision: snapshot.revision,
          upserts: [...replacements.values()],
          requiredUnchangedRefs: [...replacements.keys()],
        });
      }
      return await recheck(installation);
    },

    async discardInstallation(installationId) {
      const catalog = await readCatalog();
      const installation = catalog.installations.find((item) => item.id === installationId);
      if (installation === undefined) return;
      await discardCreatedInstallation(installation);
    },

    async getReadinessForRef(ref) {
      const parsed = PragmaInvocableResourceRefSchema.safeParse(ref);
      if (!parsed.success) return [];
      const snapshot = await options.project.get();
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
        const installations = (await readCatalog()).installations.filter((installation) =>
          installation.resourceRefs.some((resourceRef) => closureRefs.has(resourceRef)),
        );
        const readiness = await Promise.all(
          installations.map(async (installation) => {
            const current = isRecheckableInstallation(installation)
              ? (await evaluateInstallation(installation, snapshot, false)).readiness
              : mergeReadiness(
                  installation.readiness,
                  installation.pending.map(readinessFromPending),
                );
            return current
              .filter((dependency) => dependency.status !== "ready")
              .map((dependency) => ({ ...dependency, installationId: installation.id }));
          }),
        );
        return readiness.flat();
      } finally {
        await project.dispose();
      }
    },

    async isRefPending(ref) {
      return (await this.getReadinessForRef(ref)).length > 0;
    },
  };
}

interface DesktopBundleArchive {
  readonly bundle: DecodedPragmaBundle;
  readonly manifest: {
    readonly bundleFingerprint: string;
    readonly projectFingerprint: string;
    readonly createdAt: string;
    readonly roots: readonly {
      readonly ref: string;
      readonly kind: "Expert" | "ExpertTeam" | "Flow" | "ContextStore";
      readonly name: string;
    }[];
    readonly root: {
      readonly ref: string;
      readonly kind: "Expert" | "ExpertTeam" | "Flow" | "ContextStore";
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
        readonly definition?: z.infer<typeof CapabilityDefinitionSchema>;
        readonly logicalId?: string;
        readonly sourceRevision?: number;
        readonly history?: readonly {
          readonly revision: number;
          readonly definition: z.infer<typeof CapabilityDefinitionSchema>;
        }[];
        readonly included: boolean;
        readonly payloadRoot?: string;
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
          resource.kind !== "ContextStore")
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
        const v2 =
          requirement.payload?.codec === "pragma.desktop.capability@v2"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                DesktopCapabilityPayloadDescriptorV2Schema,
                `Capability descriptor ${requirement.id}`,
              )
            : undefined;
        const included =
          requirement.payload?.codec === "pragma.desktop.capability@v1" || v2 !== undefined;
        const definition =
          v2?.definition ??
          (requirement.payload?.codec === "pragma.desktop.capability@v1"
            ? parseBundlePayloadJson(
                requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
                CapabilityDefinitionSchema,
                `Capability descriptor ${requirement.id}`,
              )
            : undefined);
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
              }),
          ...(v2 === undefined
            ? {}
            : {
                logicalId: v2.logicalId,
                sourceRevision: v2.revision,
                ...(v2.revisions === undefined ? {} : { history: v2.revisions }),
              }),
          included,
          ...(requirement.payload === undefined ? {} : { payloadRoot: requirement.payload.root }),
        });
      } else if (requirement.kind === "binding" && owner?.kind === "ContextStore") {
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
          (v3?.contentIncluded ?? false);
        contextStores.push({
          requirementId: requirement.id,
          resourceRef: requirement.ownerRef,
          name: metadata?.name ?? owner.metadata.name,
          description: metadata?.description ?? owner.metadata.description,
          ...(metadata === undefined ? {} : { fingerprint: metadata.fingerprint }),
          ...(v2 === undefined
            ? {}
            : { sourceId: v2.sourceId, contentIncluded: v2.contentIncluded }),
          ...(v3 === undefined ? {} : { contentIncluded: v3.contentIncluded }),
          ...(v3?.snapshot === undefined ? {} : { snapshot: v3.snapshot }),
          included,
          ...(requirement.payload === undefined || !included || v3 !== undefined
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
    return {
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

async function addDirectoryFiles(
  files: Map<string, Uint8Array>,
  sourceRoot: string,
  targetRoot: string,
  excludedNames: ReadonlySet<string> = new Set(),
): Promise<void> {
  const canonicalRoot = await resolveRegularDirectory(sourceRoot);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludedNames.has(entry.name)) continue;
      const source = join(directory, entry.name);
      const info = await lstat(source);
      if (info.isSymbolicLink())
        throw new Error(`Bundle payload contains a symbolic link: ${source}`);
      if (info.isDirectory()) {
        await visit(source);
      } else if (info.isFile()) {
        const relativePath = relative(canonicalRoot, source).split(sep).join("/");
        const path = targetRoot === "" ? relativePath : `${targetRoot}/${relativePath}`;
        if (files.has(path)) throw new Error(`Duplicate bundle path: ${path}`);
        files.set(path, new Uint8Array(await readFile(source)));
      }
    }
  };
  await visit(canonicalRoot);
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

async function resolveRegularDirectory(path: string): Promise<string> {
  const canonical = resolve(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Expected a directory: ${path}`);
  return canonical;
}

async function materializePrefix(
  files: ReadonlyMap<string, Uint8Array>,
  prefix: string,
  temporaryPrefix: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), temporaryPrefix));
  for (const [path, contents] of filesBelowPrefix(files, prefix)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, contents, { mode: 0o600 });
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
