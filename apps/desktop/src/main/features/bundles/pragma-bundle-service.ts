import { randomUUID } from "node:crypto";
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
import { PragmaProjectValidationError } from "@pragma/interpreter";
import {
  PragmaInvocableResourceRefSchema,
  PragmaResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaInvocableResource,
  type PragmaResource,
  type PragmaResourceRef,
} from "@pragma/interpreter/ast";
import { strFromU8, strToU8, zipSync } from "fflate";
import { z } from "zod";

import {
  CreateCapabilitySchema,
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
  desktopCapabilityBindingRef,
  desktopContextBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import {
  MAX_BUNDLE_ARCHIVE_BYTES,
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_UNPACKED_BYTES,
  PragmaBundleManifestSchema,
  createBundleFingerprint,
  createPragmaBundleZip,
  isPortableValue,
  readPragmaBundle,
  sha256,
  stableStringify,
  writeBundleAtomically,
  type BundleManifest,
} from "./pragma-bundle-format.ts";
import {
  assertPortablePluginConfigs,
  assertUniqueResolutionRefs,
  collectCapabilities,
  collectContexts,
  collectPlugins,
  collectRuntimes,
  inspectPendingDependencies,
  mergePendingMetadata,
  pendingBinding,
  runtimeDependencyAvailable,
  unique,
} from "./pragma-bundle-dependencies.ts";
import {
  artifactPathIsReferenced,
  collectProjectArtifactPaths,
  collectResourceClosure,
  findBundleConflicts,
  isBundleOwnedArtifact,
  makePortableBundleResources,
  rewriteBundleWithResolutions,
  rewriteProjectArtifactPaths,
} from "./pragma-bundle-resources.ts";

const InstallationCatalogSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-installations/v2"),
    installations: z.array(PragmaBundleInstallationSchema),
  })
  .strict();

function findIncompleteInstallation(
  installations: readonly PragmaBundleInstallation[],
  bundleFingerprint: string,
): PragmaBundleInstallation | undefined {
  return installations
    .filter(
      (installation) =>
        installation.bundleFingerprint === bundleFingerprint && installation.status !== "ready",
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
  }>;
  inspect(sourcePath: string): Promise<PragmaBundleImportInspection>;
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
  readonly externalResourceRefs?: ReadonlySet<string> | undefined;
}): PragmaBundleService {
  const readCatalogFile = async (): Promise<z.infer<typeof InstallationCatalogSchema>> => {
    try {
      return InstallationCatalogSchema.parse(
        JSON.parse(await readFile(options.paths.bundleInstallationsCatalog(), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: "pragma.bundle-installations/v2", installations: [] };
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
    const root = snapshot.resources.find(
      (resource): resource is PragmaInvocableResource =>
        canonicalPragmaResourceRef(resource) === rootRef &&
        (resource.kind === "Expert" || resource.kind === "ExpertTeam" || resource.kind === "Flow"),
    );
    if (root === undefined) throw new Error(`Bundle root not found: ${rootRef}`);
    const resources = collectResourceClosure(
      root,
      snapshot.resources,
      options.externalResourceRefs,
    );
    const capabilities = await collectCapabilities(resources, options.capabilities);
    const contexts = await collectContexts(resources, options.contextStores);
    const plugins = await collectPlugins(resources, options.plugins);
    await assertPortablePluginConfigs(resources, plugins, options.plugins);
    const runtimes = collectRuntimes(resources);
    const flows = resources.filter((resource) => resource.kind === "Flow");
    return { snapshot, root, resources, capabilities, contexts, plugins, runtimes, flows };
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
    const retainedArtifactPaths = collectProjectArtifactPaths(retainedResources);
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
          knowledgeBases: false,
          flowLayouts: true,
        },
      });
    },

    async exportTo(input, destinationPath) {
      const prepared = await prepare(input.rootRef, input.projectRevision);
      const portableResources = makePortableBundleResources(prepared.resources);
      const allArtifacts = await options.project.readArtifacts(input.projectRevision);
      const artifactPaths = collectProjectArtifactPaths(portableResources);
      const artifacts = new Map(
        [...allArtifacts].filter(([path]) =>
          artifactPaths.some(
            (source) => path === source || path.startsWith(`${source.replace(/\/+$/, "")}/`),
          ),
        ),
      );
      let rendered: ReadonlyMap<string, string>;
      try {
        rendered = await options.project.renderProjectFiles({
          resources: portableResources,
          artifacts,
        });
      } catch (error) {
        throwBundleExportValidationError(error);
      }
      const files = new Map<string, Uint8Array>(
        [...rendered].map(([path, contents]) => [path, strToU8(contents)]),
      );

      const capabilities = await Promise.all(
        prepared.capabilities.map(async (dependency) => {
          const definition =
            input.modules.capabilities &&
            dependency.capability !== undefined &&
            isPortableValue(dependency.capability.definition)
              ? dependency.capability.definition
              : undefined;
          const included = definition !== undefined;
          const payloadRoot =
            included && definition.kind === "skill"
              ? `payloads/capabilities/${dependency.resource.metadata.id}`
              : undefined;
          if (payloadRoot !== undefined && dependency.capability !== undefined) {
            const source = await options.capabilities.skillFilesPath(
              dependency.capability.manifest.id,
              dependency.capability.manifest.latestRevision,
            );
            await addDirectoryFiles(files, source, payloadRoot);
          }
          return {
            resourceRef: canonicalPragmaResourceRef(dependency.resource),
            name: dependency.capability?.manifest.name ?? dependency.resource.metadata.name,
            ...(dependency.capability === undefined
              ? {}
              : {
                  kind: dependency.capability.definition.kind,
                  definitionFingerprint: sha256(stableStringify(dependency.capability.definition)),
                }),
            ...(definition === undefined ? {} : { definition }),
            included,
            ...(payloadRoot === undefined ? {} : { payloadRoot }),
          };
        }),
      );

      const contextStores = await Promise.all(
        prepared.contexts.map(async (dependency) => {
          const included = input.modules.knowledgeBases && dependency.store !== undefined;
          const payloadRoot = included
            ? `payloads/context-stores/${dependency.resource.metadata.id}`
            : undefined;
          if (payloadRoot !== undefined && dependency.store !== undefined) {
            await addDirectoryFiles(
              files,
              await options.contextStores.filesPath(dependency.store.id),
              payloadRoot,
            );
          }
          return {
            resourceRef: canonicalPragmaResourceRef(dependency.resource),
            name: dependency.store?.name ?? dependency.resource.metadata.name,
            description: dependency.store?.description ?? dependency.resource.metadata.description,
            ...(dependency.store === undefined
              ? {}
              : { fingerprint: await options.contextStores.fingerprint(dependency.store.id) }),
            included,
            ...(payloadRoot === undefined ? {} : { payloadRoot }),
          };
        }),
      );

      const plugins = await Promise.all(
        prepared.plugins.map(async (dependency) => {
          const packageInfo = dependency.packageInfo;
          const origin: "built_in" | "user" | "missing" = packageInfo?.origin ?? "missing";
          const included =
            input.modules.plugins && packageInfo !== undefined && packageInfo.origin === "user";
          const payloadRoot = included ? `payloads/plugins/${sha256(dependency.ref)}` : undefined;
          if (payloadRoot !== undefined && packageInfo !== undefined) {
            await addDirectoryFiles(
              files,
              packageInfo.root,
              payloadRoot,
              new Set([".pragma-install.json"]),
            );
          }
          return {
            ref: dependency.ref,
            name: dependency.plugin?.manifest.name ?? dependency.ref,
            origin,
            contentHash: packageInfo?.contentHash,
            ...(dependency.plugin === undefined ? {} : { manifest: dependency.plugin.manifest }),
            included,
            ...(payloadRoot === undefined ? {} : { payloadRoot }),
          };
        }),
      );

      if (input.modules.flowLayouts) {
        for (const flow of prepared.flows) {
          const layout = await options.layouts.get({
            projectId: prepared.snapshot.projectId,
            flowId: flow.metadata.id,
          });
          if (layout !== null) {
            files.set(
              `layouts/flows/${flow.metadata.id}.json`,
              strToU8(`${JSON.stringify(layout, null, 2)}\n`),
            );
          }
        }
      }

      if (files.size > MAX_BUNDLE_FILES) {
        throw new Error(`The bundle exceeds the ${MAX_BUNDLE_FILES.toLocaleString()} file limit.`);
      }
      const unpackedBytes = [...files.values()].reduce(
        (total, contents) => total + contents.byteLength,
        0,
      );
      if (unpackedBytes > MAX_BUNDLE_UNPACKED_BYTES) {
        throw new Error("The bundle exceeds the 1 GiB unpacked size limit.");
      }

      const fileIndex = [...files]
        .map(([path, contents]) => ({
          path,
          size: contents.byteLength,
          sha256: sha256(contents),
        }))
        .toSorted((left, right) => left.path.localeCompare(right.path));
      const manifestWithoutFingerprint = {
        schemaVersion: "pragma.desktop-bundle/v1" as const,
        createdAt: new Date().toISOString(),
        source: {
          projectId: prepared.snapshot.projectId,
          revision: prepared.snapshot.revision,
          ...(prepared.snapshot.projectFingerprint === undefined
            ? {}
            : { projectFingerprint: prepared.snapshot.projectFingerprint }),
        },
        root: {
          ref: canonicalPragmaResourceRef(prepared.root),
          kind: prepared.root.kind,
          name: prepared.root.metadata.name,
        },
        modules: input.modules,
        resourceCount: portableResources.length,
        projectArtifacts: [...artifacts.keys()].toSorted(),
        dependencies: {
          capabilities,
          contextStores,
          plugins,
          runtimes: prepared.runtimes,
        },
        files: fileIndex,
      } satisfies Omit<BundleManifest, "bundleFingerprint">;
      const bundleFingerprint = createBundleFingerprint(manifestWithoutFingerprint);
      const manifest = PragmaBundleManifestSchema.parse({
        ...manifestWithoutFingerprint,
        bundleFingerprint,
      });
      files.set("bundle.json", strToU8(`${JSON.stringify(manifest, null, 2)}\n`));
      const archive = await createPragmaBundleZip(files);
      if (archive.byteLength > MAX_BUNDLE_ARCHIVE_BYTES) {
        throw new Error("The bundle exceeds the 512 MiB archive limit.");
      }
      await writeBundleAtomically(destinationPath, archive);
      return PragmaBundleExportResultSchema.parse({
        cancelled: false,
        path: destinationPath,
        bundleFingerprint,
      }) as { readonly path: string; readonly bundleFingerprint: string };
    },

    async inspect(sourcePath) {
      const archive = await readPragmaBundle(sourcePath, options.externalResourceRefs);
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
            id: `capability:${dependency.resourceRef}`,
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
            id: `context-store:${dependency.resourceRef}`,
            kind: "context-store",
            resourceRef: dependency.resourceRef,
            name: dependency.name,
            message: "Choose an existing knowledge base.",
            required: true,
          });
        }
      }
      for (const dependency of archive.manifest.dependencies.plugins) {
        const exact = plugins.find(
          (plugin) =>
            plugin.ref === dependency.ref &&
            (dependency.contentHash === undefined || plugin.contentHash === dependency.contentHash),
        );
        if (exact === undefined && !dependency.included) {
          requirements.push({
            id: `plugin:${dependency.ref}`,
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
          id: `runtime:${dependency.resourceRef}`,
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
      const secretBindings = unique(
        archive.resources.flatMap((resource) =>
          resource.kind === "Expert"
            ? resource.spec.plugins.flatMap((plugin) => Object.values(plugin.secretBindings ?? {}))
            : [],
        ),
      );
      for (const binding of secretBindings) {
        if (await options.plugins.hasSecret(binding)) continue;
        const owner = archive.resources.find(
          (resource) =>
            resource.kind === "Expert" &&
            resource.spec.plugins.some((plugin) =>
              Object.values(plugin.secretBindings ?? {}).includes(binding),
            ),
        );
        requirements.push({
          id: `secret:${binding}`,
          kind: "secret",
          resourceRef:
            owner === undefined ? archive.manifest.root.ref : canonicalPragmaResourceRef(owner),
          name: binding,
          message: `Enter the secret for ${binding}.`,
          required: true,
        });
      }
      const incompleteInstallation = findIncompleteInstallation(
        (await readCatalog()).installations,
        archive.manifest.bundleFingerprint,
      );
      return PragmaBundleImportInspectionSchema.parse({
        sourcePath,
        sourceName: basename(sourcePath),
        bundleFingerprint: archive.manifest.bundleFingerprint,
        projectRevision: current.revision,
        root: archive.manifest.root,
        createdAt: archive.manifest.createdAt,
        archiveBytes: archive.archiveBytes,
        unpackedBytes: [...archive.files.values()].reduce(
          (total, contents) => total + contents.byteLength,
          0,
        ),
        fileCount: archive.files.size,
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
        conflicts,
        requirements,
        ...(incompleteInstallation === undefined
          ? {}
          : { alreadyInstalledId: incompleteInstallation.id }),
      });
    },

    async startImport(input) {
      const archive = await readPragmaBundle(input.sourcePath, options.externalResourceRefs);
      if (archive.manifest.bundleFingerprint !== input.expectedFingerprint) {
        throw new Error("The bundle changed after inspection. Inspect it again before importing.");
      }
      return await withFileLock(
        options.paths.bundleImportLock(archive.manifest.bundleFingerprint),
        async () => {
          const catalog = await readCatalog();
          const existing = findIncompleteInstallation(
            catalog.installations,
            archive.manifest.bundleFingerprint,
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
          const rewritten = rewriteBundleWithResolutions(
            archive.resources,
            current.resources,
            input.conflicts,
          );
          const installationId = randomUUID();
          const archivePath = options.paths.bundleInstallationArchive(installationId);
          await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
          await writeBundleAtomically(
            archivePath,
            new Uint8Array(await readFile(input.sourcePath)),
          );
          const timestamp = new Date().toISOString();
          const initial = PragmaBundleInstallationSchema.parse({
            schemaVersion: "pragma.bundle-installation/v2",
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
            let resources = rewritten.resources;
            const sourceToTarget = rewritten.refMap;
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
                    dependency.payloadRoot,
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
                  id: `capability:${targetRef}`,
                  kind: "capability",
                  resourceRef: targetRef,
                  name: dependency.name,
                  message: "Choose or install a compatible capability.",
                  ...(dependency.kind === undefined ? {} : { capabilityKind: dependency.kind }),
                });
              } else {
                resource.spec.binding = desktopCapabilityBindingRef(
                  capability.manifest.id,
                  capability.manifest.latestRevision,
                );
                resource.spec.config = { key: capability.manifest.id };
                resource.metadata.tags = unique([...resource.metadata.tags, "desktop-managed"]);
                if (capability.health.status !== "ready") {
                  pending.push({
                    id: `capability:${targetRef}`,
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
                  id: `context-store:${targetRef}`,
                  kind: "context-store",
                  resourceRef: targetRef,
                  name: dependency.name,
                  message: "Choose an existing knowledge base or import its Markdown files.",
                });
              } else {
                resource.spec.binding = desktopContextBindingRef(store.id);
                resource.spec.config = { key: store.id };
                resource.metadata.tags = unique([...resource.metadata.tags, "desktop-managed"]);
              }
            }

            for (const dependency of archive.manifest.dependencies.plugins) {
              let installed = (await options.plugins.list()).find(
                (plugin) =>
                  plugin.ref === dependency.ref &&
                  (dependency.contentHash === undefined ||
                    plugin.contentHash === dependency.contentHash),
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
                pending.push({
                  id: `plugin:${dependency.ref}`,
                  kind: "plugin",
                  resourceRef: dependency.ref,
                  name: dependency.name,
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
                    id: `runtime:${targetRef}`,
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

            const requestedSecretBindings = new Set(
              archive.resources.flatMap((resource) =>
                resource.kind === "Expert"
                  ? resource.spec.plugins.flatMap((plugin) =>
                      Object.values(plugin.secretBindings ?? {}),
                    )
                  : [],
              ),
            );
            for (const binding of Object.keys(input.secrets)) {
              if (!requestedSecretBindings.has(binding)) {
                throw new Error(`Secret is not requested by this Bundle: ${binding}.`);
              }
            }
            if (Object.keys(input.secrets).length > 0) {
              await options.plugins.setSecrets(input.secrets);
            }
            for (const resource of resources) {
              if (resource.kind !== "Expert") continue;
              for (const plugin of resource.spec.plugins) {
                for (const binding of Object.values(plugin.secretBindings ?? {})) {
                  if (await options.plugins.hasSecret(binding)) continue;
                  pending.push({
                    id: `secret:${binding}`,
                    kind: "secret",
                    resourceRef: canonicalPragmaResourceRef(resource),
                    name: plugin.ref,
                    message: `Enter the secret for ${binding}.`,
                  });
                }
              }
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
            resources = resources.map((resource) =>
              rewriteProjectArtifactPaths(
                resource,
                installationId,
                archive.manifest.projectArtifacts,
              ),
            );
            const combined = [
              ...current.resources.filter(
                (resource) => !importedRefs.has(canonicalPragmaResourceRef(resource)),
              ),
              ...resources,
            ];
            const referencedArtifacts = collectProjectArtifactPaths(combined);
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
          PragmaResourceSchema.parse({
            ...resource,
            metadata: {
              ...resource.metadata,
              tags: unique([...resource.metadata.tags, "desktop-managed"]),
            },
            spec: {
              ...resource.spec,
              binding: desktopCapabilityBindingRef(resolution.capabilityId, resolution.revision),
              config: { key: resolution.capabilityId },
            },
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
          PragmaResourceSchema.parse({
            ...resource,
            metadata: {
              ...resource.metadata,
              tags: unique([...resource.metadata.tags, "desktop-managed"]),
            },
            spec: {
              ...resource.spec,
              binding: desktopContextBindingRef(resolution.storeId),
              config: { key: resolution.storeId },
            },
          }),
        );
      }
      if (Object.keys(input.secrets).length > 0) {
        const allowedSecrets = new Set(
          installation.pending.flatMap((dependency) =>
            dependency.kind === "secret" && dependency.id.startsWith("secret:")
              ? [dependency.id.slice("secret:".length)]
              : [],
          ),
        );
        for (const binding of Object.keys(input.secrets)) {
          if (!allowedSecrets.has(binding)) {
            throw new Error(`Secret is not requested by this bundle installation: ${binding}`);
          }
        }
        await options.plugins.setSecrets(input.secrets);
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
      return collectResourceClosure(root, snapshot.resources, options.externalResourceRefs).some(
        (resource) => pendingRefs.has(canonicalPragmaResourceRef(resource)),
      );
    },
  };
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
        const path = `${targetRoot}/${relative(canonicalRoot, source).split(sep).join("/")}`;
        if (files.has(path)) throw new Error(`Duplicate bundle path: ${path}`);
        files.set(path, new Uint8Array(await readFile(source)));
      }
    }
  };
  await visit(canonicalRoot);
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
