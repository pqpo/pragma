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
  PragmaInvocableResourceRefSchema,
  PragmaResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaInvocableResource,
  type PragmaResource,
  type PragmaResourceRef,
} from "@pragma/interpreter/ast";
import { strFromU8, zipSync } from "fflate";
import { z } from "zod";
import { createKnowledgeShare, type KnowledgeMemoryStore } from "@pragma/memory";
import {
  KnowledgeShareSchema,
  type Knowledge,
  type KnowledgeShare,
  type MemorySubjectRef,
} from "@pragma/shared";

import {
  CreateCapabilitySchema,
  CapabilityDefinitionSchema,
  PragmaBundleExportPreviewSchema,
  PragmaBundleExportResultSchema,
  PragmaBundleImportInspectionSchema,
  PragmaBundleInstallationSchema,
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
import type { CapabilityStore } from "../capabilities/capability-store.ts";
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
  inspectPendingDependencies,
  isPortableValue,
  mergePendingMetadata,
  pendingBinding,
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
    schemaVersion: z.literal("pragma.bundle-installations/v3"),
    installations: z.array(PragmaBundleInstallationSchema),
  })
  .strict();

const DesktopContextPayloadDescriptorSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

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
    input: Omit<ExportPragmaBundle, "knowledgeRevisionRefs"> & {
      readonly knowledgeRevisionRefs?: ExportPragmaBundle["knowledgeRevisionRefs"] | undefined;
    },
    destinationPath: string,
  ): Promise<{
    readonly path: string;
    readonly bundleFingerprint: string;
    readonly projectFingerprint: string;
  }>;
  inspect(sourcePath: string, rootRef?: string): Promise<PragmaBundleImportInspection>;
  startImport(input: StartPragmaBundleImport): Promise<PragmaBundleInstallation>;
  listInstallations(): Promise<readonly PragmaBundleInstallation[]>;
  resolveInstallation(input: ResolvePragmaBundleInstallation): Promise<PragmaBundleInstallation>;
  discardInstallation(installationId: string): Promise<void>;
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
  readonly knowledge?: KnowledgeMemoryStore | undefined;
}): PragmaBundleService {
  const readCatalogFile = async (): Promise<z.infer<typeof InstallationCatalogSchema>> => {
    try {
      return InstallationCatalogSchema.parse(
        JSON.parse(await readFile(options.paths.bundleInstallationsCatalog(), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: "pragma.bundle-installations/v3", installations: [] };
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
        await updateInstallationFile(installation.id, (current) => ({
          ...current,
          status: "failed",
          error:
            "The previous import was interrupted. Import the bundle again to retry safely, or discard this installation.",
          updatedAt: new Date().toISOString(),
        }));
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
      const resources = project.listResourceClosure(
        PragmaInvocableResourceRefSchema.parse(rootRef),
      );
      const root = resources.find(
        (resource): resource is PragmaInvocableResource =>
          canonicalPragmaResourceRef(resource) === rootRef &&
          (resource.kind === "Expert" ||
            resource.kind === "ExpertTeam" ||
            resource.kind === "Flow"),
      );
      if (root === undefined) throw new Error(`Bundle root not found: ${rootRef}`);
      const capabilities = await collectCapabilities(resources, options.capabilities);
      const contexts = await collectContexts(resources, options.contextStores);
      const plugins = await collectPlugins(resources, options.plugins);
      await assertPortablePluginConfigs(resources, plugins, options.plugins);
      const flows = resources.filter((resource) => resource.kind === "Flow");
      const knowledge =
        options.knowledge === undefined
          ? []
          : eligibleKnowledgeForExport(await options.knowledge.list(), resources, {
              type: "pragma.project",
              id: snapshot.projectId,
            });
      return {
        snapshot,
        project,
        root,
        resources,
        capabilities,
        contexts,
        plugins,
        flows,
        knowledge,
      };
    } catch (error) {
      await project.dispose();
      throw error;
    }
  };

  const recheck = async (
    installation: PragmaBundleInstallation,
  ): Promise<PragmaBundleInstallation> => {
    const snapshot = await options.project.get();
    const resources = snapshot.resources.filter((resource) =>
      installation.resourceRefs.includes(canonicalPragmaResourceRef(resource)),
    );
    const inspected = await inspectPendingDependencies(resources, {
      capabilities: options.capabilities,
      contextStores: options.contextStores,
      plugins: options.plugins,
      runtimes: await options.getRuntimes(),
    });
    const pending = mergePendingMetadata(inspected, installation.pending);
    const updated = await updateInstallation(installation.id, (current) => ({
      ...current,
      projectRevision: snapshot.revision,
      status: pending.length === 0 ? "ready" : "needs_setup",
      pending,
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
          knowledge: prepared.knowledge.map((item) => ({
            id: item.id,
            revision: item.revision,
            title: item.content.title,
            summary: item.content.summary,
          })),
          defaults: {
            capabilities: true,
            plugins: true,
            knowledgeBases: false,
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
        const knowledgeRevisionRefs = input.knowledgeRevisionRefs ?? [];
        if (knowledgeRevisionRefs.length > 0) {
          if (options.knowledge === undefined) throw new Error("Knowledge Memory is unavailable.");
          const requested = await options.knowledge.listExportable({
            projectRef: { type: "pragma.project", id: prepared.snapshot.projectId },
            refs: knowledgeRevisionRefs,
          });
          const eligibleRefs = new Set(
            prepared.knowledge.map((item) => `${item.id}\0${item.revision}`),
          );
          for (const item of requested) {
            if (!eligibleRefs.has(`${item.id}\0${item.revision}`)) {
              throw new Error(
                `Knowledge revision is outside this Bundle root: ${item.id}@${item.revision}.`,
              );
            }
          }
          const projectFingerprint = prepared.snapshot.projectFingerprint;
          if (projectFingerprint === undefined) {
            throw new Error("The current Project revision has no portable fingerprint.");
          }
          const shares = requested.map((knowledge) =>
            createKnowledgeShare({
              knowledge,
              sourceProjectFingerprint: projectFingerprint,
              provenance: knowledge.sourceRefs.map((source) => ({
                sourceKind: source.kind,
                sourceId: source.id,
                sourceRevision: source.revision,
                summary: "Reviewed Memory source revision.",
              })),
            }),
          );
          extensions.push({
            id: "pragma.memory.knowledge",
            version: "v1",
            required: true,
            files: new Map([
              ["knowledge.json", new TextEncoder().encode(`${JSON.stringify(shares, null, 2)}\n`)],
            ]),
          });
        }
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
                  const files = new Map<string, Uint8Array>([
                    [
                      "descriptor.json",
                      new TextEncoder().encode(
                        `${JSON.stringify(entry.capability.definition, null, 2)}\n`,
                      ),
                    ],
                  ]);
                  if (entry.capability.definition.kind === "skill") {
                    await addDirectoryFiles(
                      files,
                      await options.capabilities.skillFilesPath(
                        entry.capability.manifest.id,
                        entry.capability.manifest.latestRevision,
                      ),
                      "files",
                    );
                  }
                  return { codec: "pragma.desktop.capability@v1", files };
                }
                if (resource?.kind === "ContextStore" && input.modules.knowledgeBases) {
                  const entry = contextByRef.get(requirement.ownerRef);
                  if (entry?.store === undefined || originalBindingRef === undefined)
                    return undefined;
                  const files = new Map<string, Uint8Array>([
                    [
                      "descriptor.json",
                      new TextEncoder().encode(
                        `${JSON.stringify(
                          {
                            name: entry.store.name,
                            description: entry.store.description,
                            fingerprint: await options.contextStores.fingerprint(entry.store.id),
                          },
                          null,
                          2,
                        )}\n`,
                      ),
                    ],
                  ]);
                  await addDirectoryFiles(
                    files,
                    await options.contextStores.filesPath(entry.store.id),
                    "files",
                  );
                  return { codec: "pragma.desktop.context-store@v1", files };
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
      const conflicts = findBundleConflicts(archive.resources, current.resources);
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
      const requirements: PragmaBundleImportInspection["requirements"] = [];
      for (const dependency of archive.manifest.dependencies.capabilities) {
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
            message: "Choose an existing knowledge base.",
            required: true,
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
        knowledgeCount: archive.knowledgeShares.length,
        importedKnowledgePersistsAfterDiscard: archive.knowledgeShares.length > 0,
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
        conflicts,
        requirements,
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
            archive.resources,
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
            schemaVersion: "pragma.bundle-installation/v3",
            bundleVersion: "pragma.bundle/v1",
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
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          await addInstallation(initial);
          try {
            let resources = [...localized.resources];
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

            for (const dependency of archive.manifest.dependencies.capabilities) {
              const targetRef =
                sourceToTarget.get(dependency.resourceRef) ?? dependency.resourceRef;
              const resource = resources.find(
                (candidate) => canonicalPragmaResourceRef(candidate) === targetRef,
              );
              if (resource?.kind !== "Capability") continue;
              let capability =
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
                Object.assign(
                  resource,
                  bindExistingDesktopCapabilityResource(resource, {
                    id: capability.manifest.id,
                    revision: capability.manifest.latestRevision,
                  }),
                );
                if (capability.health.status !== "ready") {
                  pending.push({
                    id: dependency.requirementId,
                    kind: "capability",
                    resourceRef: targetRef,
                    name: dependency.name,
                    message:
                      capability.health.diagnostic?.message ??
                      "This capability needs credentials or connection setup.",
                    capabilityKind: capability.definition.kind,
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
              let store =
                dependency.fingerprint === undefined
                  ? undefined
                  : (
                      await Promise.all(
                        stores.map(async (candidate) => ({
                          candidate,
                          fingerprint: await options.contextStores.fingerprint(candidate.id),
                        })),
                      )
                    ).find((candidate) => candidate.fingerprint === dependency.fingerprint)
                      ?.candidate;
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
                Object.assign(resource, bindExistingDesktopContextResource(resource, store.id));
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
            for (const requirement of archive.manifest.dependencies.secrets) {
              const binding = `binding:pragma.bundle.${requirement.id}`;
              if (await options.plugins.hasSecret(binding)) continue;
              pending.push({
                id: requirement.id,
                kind: "secret",
                resourceRef: sourceToTarget.get(requirement.ownerRef) ?? requirement.ownerRef,
                name: requirement.name,
                message: `Enter the secret for ${requirement.name}.`,
              });
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

            if (archive.knowledgeShares.length > 0) {
              if (options.knowledge === undefined) {
                throw new Error("This Bundle requires Knowledge Memory support.");
              }
              await options.knowledge.importShares({
                shares: archive.knowledgeShares,
                mapRef: (sourceRef) =>
                  mapImportedKnowledgeSubject(sourceRef, sourceToTarget, published.projectId),
                actorRef: { type: "pragma.bundle-installation", id: initial.id },
                now: new Date(),
              });
            }

            const verifiedPending = await inspectPendingDependencies(
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
            const allPending = mergePendingMetadata(verifiedPending, pending);
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
          PragmaResourceSchema.parse({
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
        await options.contextStores.resolve(resolution.storeId);
        replacements.set(
          resolution.resourceRef,
          bindExistingDesktopContextResource(resource, resolution.storeId),
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

    async isRefPending(ref) {
      const parsed = PragmaInvocableResourceRefSchema.safeParse(ref);
      if (!parsed.success) return false;
      const pendingRefs = new Set(
        (await readCatalog()).installations.flatMap((installation) =>
          installation.status === "ready" ? [] : installation.resourceRefs,
        ),
      );
      if (pendingRefs.has(parsed.data)) return true;
      const snapshot = await options.project.get();
      const root = snapshot.resources.find(
        (resource): resource is PragmaInvocableResource =>
          canonicalPragmaResourceRef(resource) === parsed.data &&
          (resource.kind === "Expert" ||
            resource.kind === "ExpertTeam" ||
            resource.kind === "Flow"),
      );
      if (root === undefined) return false;
      const project = await options.project.openRevision(snapshot.revision);
      try {
        return project
          .listResourceClosure(parsed.data)
          .some((resource) => pendingRefs.has(canonicalPragmaResourceRef(resource)));
      } finally {
        await project.dispose();
      }
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
      readonly kind: "Expert" | "ExpertTeam" | "Flow";
      readonly name: string;
    }[];
    readonly root: {
      readonly ref: string;
      readonly kind: "Expert" | "ExpertTeam" | "Flow";
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
        readonly included: boolean;
        readonly payloadRoot?: string;
      }[];
      readonly contextStores: readonly {
        readonly requirementId: string;
        readonly resourceRef: string;
        readonly name: string;
        readonly description: string;
        readonly fingerprint?: string;
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
  readonly knowledgeShares: readonly KnowledgeShare[];
  readonly archiveBytes: number;
  readonly fileCount: number;
  readonly unpackedBytes: number;
}

async function readDesktopBundle(
  sourcePath: string,
  requestedRootRef?: string,
): Promise<DesktopBundleArchive> {
  if (!sourcePath.toLowerCase().endsWith(".pragma")) throw new Error("Select a .pragma file.");
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
      supportedBundleExtensions: new Set([
        "pragma.desktop.flow-layout@v1",
        "pragma.memory.knowledge@v1",
      ]),
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
        (resource.kind !== "Expert" && resource.kind !== "ExpertTeam" && resource.kind !== "Flow")
      ) {
        throw new Error(`Bundle root is unavailable: ${ref}.`);
      }
      return { ref, kind: resource.kind, name: resource.metadata.name };
    });
    const selectedRef = requestedRootRef ?? roots[0]?.ref;
    const root = roots.find((candidate) => candidate.ref === selectedRef);
    if (root === undefined) throw new Error(`Bundle root is unavailable: ${String(selectedRef)}.`);
    const resources = project.listResourceClosure(PragmaInvocableResourceRefSchema.parse(root.ref));
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
    const knowledgeExtension = decoded.manifest.extensions.find(
      (extension) => `${extension.id}@${extension.version}` === "pragma.memory.knowledge@v1",
    );
    const knowledgeShares =
      knowledgeExtension === undefined
        ? []
        : KnowledgeShareSchema.array().parse(
            JSON.parse(
              strFromU8(
                requiredBundlePayloadFile(
                  filesBelowPrefix(decoded.files, knowledgeExtension.root),
                  "knowledge.json",
                  "pragma.memory.knowledge@v1",
                ),
              ),
            ),
          );

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
        const included = requirement.payload?.codec === "pragma.desktop.capability@v1";
        const definition = included
          ? parseBundlePayloadJson(
              requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
              CapabilityDefinitionSchema,
              `Capability descriptor ${requirement.id}`,
            )
          : undefined;
        capabilities.push({
          requirementId: requirement.id,
          resourceRef: requirement.ownerRef,
          name: owner.metadata.name,
          ...(definition === undefined
            ? {}
            : {
                kind: definition.kind,
                definition,
                definitionFingerprint: sha256(stableStringify(definition)),
              }),
          included,
          ...(requirement.payload === undefined ? {} : { payloadRoot: requirement.payload.root }),
        });
      } else if (requirement.kind === "binding" && owner?.kind === "ContextStore") {
        const included = requirement.payload?.codec === "pragma.desktop.context-store@v1";
        const metadata = included
          ? parseBundlePayloadJson(
              requiredBundlePayloadFile(payloadFiles, "descriptor.json", requirement.id),
              DesktopContextPayloadDescriptorSchema,
              `ContextStore descriptor ${requirement.id}`,
            )
          : undefined;
        contextStores.push({
          requirementId: requirement.id,
          resourceRef: requirement.ownerRef,
          name: metadata?.name ?? owner.metadata.name,
          description: metadata?.description ?? owner.metadata.description,
          ...(metadata === undefined ? {} : { fingerprint: metadata.fingerprint }),
          included,
          ...(requirement.payload === undefined
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
      knowledgeShares,
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

function eligibleKnowledgeForExport(
  items: readonly Knowledge[],
  resources: readonly PragmaResource[],
  projectRef: MemorySubjectRef,
): readonly Knowledge[] {
  const closure = new Set(resources.map(canonicalPragmaResourceRef));
  const mappable = (ref: MemorySubjectRef): boolean =>
    sameSubject(ref, projectRef) ||
    (subjectToPragmaRef(ref) !== undefined && closure.has(subjectToPragmaRef(ref)!));
  return items.filter(
    (item) =>
      item.status === "active" &&
      item.visibility.mode !== "host-private" &&
      item.sensitivity !== "restricted" &&
      mappable(item.rootRef) &&
      item.producerRefs.every(mappable) &&
      item.bindings.every((binding) => mappable(binding.consumerRef)) &&
      (item.visibility.mode !== "restricted" || item.visibility.principals.every(mappable)) &&
      item.bindings.some(
        (binding) => sameSubject(binding.consumerRef, projectRef) && binding.export === "allow",
      ),
  );
}

function mapImportedKnowledgeSubject(
  ref: MemorySubjectRef,
  resourceMappings: ReadonlyMap<string, string>,
  projectId: string,
): MemorySubjectRef | undefined {
  if (ref.type === "pragma.project") return { type: "pragma.project", id: projectId };
  const source = subjectToPragmaRef(ref);
  if (source === undefined) return undefined;
  const target = resourceMappings.get(source) ?? source;
  const separator = target.indexOf(":");
  if (separator <= 0 || separator === target.length - 1) return undefined;
  const type =
    target.slice(0, separator) === "expert"
      ? "pragma.expert"
      : target.slice(0, separator) === "team"
        ? "pragma.expert-team"
        : target.slice(0, separator) === "flow"
          ? "pragma.flow"
          : undefined;
  return type === undefined ? undefined : { type, id: target.slice(separator + 1) };
}

function subjectToPragmaRef(ref: MemorySubjectRef): string | undefined {
  const namespace =
    ref.type === "pragma.expert"
      ? "expert"
      : ref.type === "pragma.expert-team"
        ? "team"
        : ref.type === "pragma.flow"
          ? "flow"
          : undefined;
  return namespace === undefined ? undefined : `${namespace}:${ref.id}`;
}

function sameSubject(left: MemorySubjectRef, right: MemorySubjectRef): boolean {
  return left.type === right.type && left.id === right.id;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
