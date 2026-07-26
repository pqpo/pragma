import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  PragmaDslMigrationError,
  PragmaProjectRevisionConflictError,
  PragmaProjectService,
  PragmaProjectValidationError,
  loadPragmaProject,
  migratePragmaDslProjectToCurrent,
  parsePragmaYaml,
  type PragmaProject,
  type CompiledResource,
  type InvocableResource,
  type PragmaProjectRevisionLocation,
  type PragmaProjectSourceRepository,
  type PragmaProjectChangeSetInput,
  type PragmaResourceIdentityMigration,
} from "@pragma/interpreter";
import type { PragmaLoggerProvider } from "@pragma/core";
import {
  PragmaDiagnosticSchema,
  PragmaExpertIdSchema,
  PragmaResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaDiagnostic,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { z } from "zod";
import {
  ContentAddressedStore,
  type PragmaPaths,
  assertStorageWriteAllowed,
  withFileLock,
} from "@pragma/core";

import {
  PragmaProjectSnapshotSchema,
  type PragmaProjectSnapshot,
  type PragmaYamlValidationResult,
} from "../shared/desktop-api.ts";
import { referencingPragmaResources } from "./pragma-resource-references.ts";

const ProjectManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-project/v4"),
    projectId: z.string().min(1),
    headRevision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const ProjectRevisionManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.project-revision/v4"),
    projectId: z.string().min(1),
    revision: z.number().int().positive(),
    parentRevision: z.number().int().positive().optional(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    compilerVersion: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

const ProjectIdentityMigrationManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-project-identity-migrations/v1"),
    projectId: z.string().min(1),
    migrations: z.array(
      z
        .object({
          kind: z.enum([
            "Expert",
            "ExpertTeam",
            "Flow",
            "Automation",
            "Capability",
            "ContextStore",
            "RuntimeProfile",
          ]),
          sourceId: z.string().min(1),
          targetId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export interface PragmaProjectStore {
  get(): Promise<PragmaProjectSnapshot>;
  ensurePublished(): Promise<PragmaProjectSnapshot>;
  publish(input: {
    readonly expectedRevision: number;
    readonly resources: readonly PragmaResource[];
    readonly artifacts?: ReadonlyMap<string, string> | undefined;
  }): Promise<PragmaProjectSnapshot>;
  upsert(input: {
    readonly baseRevision: number;
    readonly resource: PragmaResource;
    readonly requiredUnchangedRefs?: readonly string[] | undefined;
  }): Promise<PragmaProjectSnapshot>;
  apply(input: PragmaProjectChangeSetInput): Promise<PragmaProjectSnapshot>;
  remove(input: {
    readonly baseRevision: number;
    readonly ref: string;
  }): Promise<PragmaProjectSnapshot>;
  validateYaml(source: string): Promise<PragmaYamlValidationResult>;
  validateCandidate(input: {
    readonly baseRevision: number;
    readonly resource: PragmaResource;
    readonly requiredUnchangedRefs?: readonly string[] | undefined;
  }): Promise<PragmaYamlValidationResult>;
  validateChanges(input: PragmaProjectChangeSetInput): Promise<readonly PragmaDiagnostic[]>;
  compile<T extends InvocableResource>(
    input: Parameters<PragmaProjectService["compile"]>[0],
  ): Promise<CompiledResource<T>>;
  openRevision(revision: number): Promise<PragmaProject>;
  readIdentityMigrations(): Promise<readonly PragmaResourceIdentityMigration[]>;
  readonly projectId: string;
}

export class PragmaProjectStoreError extends Error {
  constructor(
    readonly code:
      | "project_invalid"
      | "revision_conflict"
      | "resource_not_found"
      | "resource_referenced"
      | "built_in_readonly"
      | "project_io"
      | "unsupported_format",
    message: string,
    readonly diagnostics: readonly PragmaDiagnostic[] = [],
    readonly conflict:
      | {
          readonly baseRevision: number;
          readonly currentRevision: number;
          readonly conflictingRefs: readonly string[];
          readonly retryable: boolean;
        }
      | undefined = undefined,
  ) {
    super(message);
    this.name = "PragmaProjectStoreError";
  }
}

export function createPragmaProjectStore(options: {
  readonly projectsPath: string;
  readonly objectsPath?: string | undefined;
  readonly projectViewsPath?: string | undefined;
  readonly storagePaths?: PragmaPaths | undefined;
  readonly projectId?: string;
  readonly reservedResourceRefs?: ReadonlySet<string> | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
}): PragmaProjectStore {
  const projectId = options.projectId ?? "studio";
  const repository = createDesktopProjectSourceRepository({
    projectsPath: options.projectsPath,
    objectsPath: options.objectsPath ?? join(options.projectsPath, ".storage", "objects"),
    projectViewsPath: options.projectViewsPath ?? join(options.projectsPath, ".cache", "views"),
  });
  const service = new PragmaProjectService({
    repository,
    externalResourceRefs: options.reservedResourceRefs,
    loggerProvider: options.loggerProvider,
  });
  const ensureMigrated = async (): Promise<void> =>
    await migrateDesktopProjectStorageV3ToV4({
      projectsPath: options.projectsPath,
      objectsPath: options.objectsPath ?? join(options.projectsPath, ".storage", "objects"),
      projectId,
      publish: async (expectedRevision, resources, artifacts) => {
        await service.publish({
          projectId,
          expectedRevision,
          resources,
          artifacts,
          forceRevision: true,
        });
      },
    });

  const get = async (): Promise<PragmaProjectSnapshot> => {
    await ensureMigrated();
    return PragmaProjectSnapshotSchema.parse(await service.get(projectId));
  };

  const readIdentityMigrations = async (): Promise<readonly PragmaResourceIdentityMigration[]> => {
    await ensureMigrated();
    try {
      const manifest = ProjectIdentityMigrationManifestSchema.parse(
        JSON.parse(
          await readFile(join(options.projectsPath, projectId, "identity-migrations.json"), "utf8"),
        ) as unknown,
      );
      if (manifest.projectId !== projectId) {
        throw new PragmaProjectStoreError(
          "project_invalid",
          `Project identity migration index belongs to ${manifest.projectId}, expected ${projectId}.`,
        );
      }
      return manifest.migrations;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  };

  const normalizeError = (error: unknown): never => {
    if (error instanceof PragmaProjectRevisionConflictError) {
      throw new PragmaProjectStoreError("revision_conflict", error.message, [], {
        baseRevision: error.baseRevision,
        currentRevision: error.currentRevision,
        conflictingRefs: error.conflictingRefs,
        retryable: error.retryable,
      });
    }
    if (error instanceof PragmaProjectValidationError) {
      throw new PragmaProjectStoreError("project_invalid", error.message, error.diagnostics);
    }
    throw error;
  };
  const assertNotReserved = (resources: readonly PragmaResource[]): void => {
    const reserved = resources.find((resource) =>
      options.reservedResourceRefs?.has(canonicalPragmaResourceRef(resource)),
    );
    if (reserved !== undefined) {
      throw new PragmaProjectStoreError(
        "built_in_readonly",
        `Built-in resource refs are reserved: ${canonicalPragmaResourceRef(reserved)}.`,
      );
    }
  };

  const validateChanges = async (
    input: PragmaProjectChangeSetInput,
  ): Promise<readonly PragmaDiagnostic[]> => {
    try {
      const candidate = await service.materializeChangeSet(projectId, input);
      return [
        ...desktopExpertAuthoringDiagnostics(candidate.resources),
        ...(await service.validate({
          resources: candidate.resources,
          artifacts: candidate.artifacts,
        })),
      ];
    } catch (error) {
      return normalizeError(error);
    }
  };

  const apply = async (input: PragmaProjectChangeSetInput): Promise<PragmaProjectSnapshot> => {
    try {
      if (options.storagePaths !== undefined) await assertStorageWriteAllowed(options.storagePaths);
      const upserts = (input.upserts ?? []).map((resource) => PragmaResourceSchema.parse(resource));
      assertNotReserved(upserts);
      if (input.removals?.some((ref) => options.reservedResourceRefs?.has(ref)) === true) {
        throw new PragmaProjectStoreError(
          "built_in_readonly",
          "Built-in resource refs cannot be removed.",
        );
      }
      const candidate = await service.materializeChangeSet(projectId, { ...input, upserts });
      const orphanedFlowRuntimeProfiles = new Set(
        candidate.resources
          .filter(
            (resource) =>
              resource.kind === "RuntimeProfile" &&
              resource.metadata.tags.includes("flow-runtime-override") &&
              referencingPragmaResources(candidate.resources, canonicalPragmaResourceRef(resource))
                .length === 0,
          )
          .map(canonicalPragmaResourceRef),
      );
      const effectiveChangeSet = {
        ...input,
        upserts: upserts.filter(
          (resource) => !orphanedFlowRuntimeProfiles.has(canonicalPragmaResourceRef(resource)),
        ),
        removals: [...new Set([...(input.removals ?? []), ...orphanedFlowRuntimeProfiles])],
      } satisfies PragmaProjectChangeSetInput;
      const effectiveCandidate = await service.materializeChangeSet(projectId, effectiveChangeSet);
      assertDesktopExpertAuthoring(effectiveCandidate.resources);
      return PragmaProjectSnapshotSchema.parse(
        await service.applyChangeSet({ projectId, changeSet: effectiveChangeSet }),
      );
    } catch (error) {
      return normalizeError(error);
    }
  };

  const publish = async (input: {
    readonly expectedRevision: number;
    readonly resources: readonly PragmaResource[];
    readonly artifacts?: ReadonlyMap<string, string> | undefined;
  }): Promise<PragmaProjectSnapshot> => {
    try {
      if (options.storagePaths !== undefined) await assertStorageWriteAllowed(options.storagePaths);
      assertNotReserved(input.resources);
      assertDesktopExpertAuthoring(input.resources);
      const artifacts =
        input.artifacts ??
        (input.expectedRevision === 0
          ? new Map<string, string>()
          : await readRevisionArtifacts(
              repository,
              projectId,
              input.expectedRevision,
              await get(),
            ));
      return PragmaProjectSnapshotSchema.parse(
        await service.publish({ projectId, ...input, artifacts }),
      );
    } catch (error) {
      return normalizeError(error);
    }
  };

  const ensurePublished = async (): Promise<PragmaProjectSnapshot> => {
    const current = await get();
    if (current.revision > 0) return current;

    try {
      return await publish({ expectedRevision: current.revision, resources: current.resources });
    } catch (error) {
      if (error instanceof PragmaProjectStoreError && error.code === "revision_conflict") {
        const latest = await get();
        if (latest.revision > 0) return latest;
      }
      throw error;
    }
  };

  return {
    projectId,
    get,
    ensurePublished,
    publish,
    async upsert(input) {
      return await apply({
        baseRevision: input.baseRevision,
        upserts: [input.resource],
        requiredUnchangedRefs:
          input.requiredUnchangedRefs === undefined ? undefined : [...input.requiredUnchangedRefs],
      });
    },
    apply,
    async remove(input) {
      const snapshot = await get();
      const resource = snapshot.resources.find(
        (candidate) => canonicalPragmaResourceRef(candidate) === input.ref,
      );
      if (resource === undefined) {
        throw new PragmaProjectStoreError("resource_not_found", `Resource not found: ${input.ref}`);
      }
      if (referencingPragmaResources(snapshot.resources, input.ref).length > 0) {
        throw new PragmaProjectStoreError(
          "resource_referenced",
          "This resource is used by another Expert, Expert Team, or Flow. Remove those dependencies before deleting it.",
        );
      }
      return await apply({
        baseRevision: input.baseRevision,
        upserts: [],
        removals: [input.ref],
      });
    },
    async validateYaml(source) {
      try {
        const parsed = PragmaResourceSchema.safeParse(parsePragmaYaml(source));
        if (!parsed.success) return { diagnostics: issuesToDiagnostics(parsed.error.issues) };
        const diagnostics = await service.validate({ resources: [parsed.data] });
        return {
          resource: parsed.data,
          diagnostics: [...desktopExpertAuthoringDiagnostics([parsed.data]), ...diagnostics],
        };
      } catch (error) {
        return {
          diagnostics: [
            PragmaDiagnosticSchema.parse({
              severity: "error",
              code: "source.parse",
              message: error instanceof Error ? error.message : String(error),
              path: [],
            }),
          ],
        };
      }
    },
    async validateCandidate(input) {
      const resource = PragmaResourceSchema.parse(input.resource);
      return {
        resource,
        diagnostics: [
          ...(await validateChanges({
            baseRevision: input.baseRevision,
            upserts: [resource],
            requiredUnchangedRefs:
              input.requiredUnchangedRefs === undefined
                ? undefined
                : [...input.requiredUnchangedRefs],
          })),
        ],
      };
    },
    validateChanges,
    async compile<T extends InvocableResource>(
      input: Parameters<PragmaProjectService["compile"]>[0],
    ) {
      return await service.compile<T>(input);
    },
    async openRevision(revision) {
      const location = await repository.getRevision(projectId, revision);
      if (location === undefined) {
        throw new PragmaProjectStoreError(
          "project_invalid",
          `Pragma project revision not found: ${projectId}@${revision}`,
        );
      }
      return await loadPragmaProject(location.entryFile, {
        rootDir: location.rootDir,
        requireLock: true,
      });
    },
    readIdentityMigrations,
  };
}

function assertDesktopExpertAuthoring(resources: readonly PragmaResource[]): void {
  const diagnostics = desktopExpertAuthoringDiagnostics(resources);
  if (diagnostics.length === 0) return;
  throw new PragmaProjectStoreError(
    "project_invalid",
    "The Expert definition is incomplete or invalid.",
    diagnostics,
  );
}

function desktopExpertAuthoringDiagnostics(
  resources: readonly PragmaResource[],
): PragmaDiagnostic[] {
  const runtimes = new Map(
    resources
      .filter((resource) => resource.kind === "RuntimeProfile")
      .map((resource) => [canonicalPragmaResourceRef(resource), resource] as const),
  );
  const diagnostics: PragmaDiagnostic[] = [];
  const add = (message: string, path: readonly (string | number)[]) => {
    diagnostics.push(
      PragmaDiagnosticSchema.parse({
        severity: "error",
        code: "desktop.expert.required",
        message,
        path,
      }),
    );
  };

  for (const resource of resources) {
    if (resource.kind !== "Expert") continue;
    const id = PragmaExpertIdSchema.safeParse(resource.metadata.id);
    if (!id.success) {
      for (const issue of id.error.issues) {
        add(issue.message, [resource.metadata.id, "metadata", "id"]);
      }
    }
    if (resource.spec.runtime === undefined) {
      add("Runtime is required.", [resource.metadata.id, "spec", "runtime"]);
      continue;
    }
    const runtime = runtimes.get(resource.spec.runtime.ref);
    if (runtime === undefined) continue;
    const config = runtime.spec.config as Record<string, unknown>;
    if (typeof config.runtimeId !== "string" || config.runtimeId.trim() === "") {
      add("Runtime ID is required.", [runtime.metadata.id, "spec", "config", "runtimeId"]);
    }
    if (typeof config.providerId !== "string" || config.providerId.trim() === "") {
      add("Model provider is required.", [runtime.metadata.id, "spec", "config", "providerId"]);
    }
    if (typeof config.model !== "string" || config.model.trim() === "") {
      add("Model is required.", [runtime.metadata.id, "spec", "config", "model"]);
    }
  }
  return diagnostics;
}

function createDesktopProjectSourceRepository(options: {
  readonly projectsPath: string;
  readonly objectsPath: string;
  readonly projectViewsPath: string;
}): PragmaProjectSourceRepository {
  const projectPath = (projectId: string) => join(options.projectsPath, projectId);
  const manifestPath = (projectId: string) => join(projectPath(projectId), "project.json");
  const revisionManifestPath = (projectId: string, revision: number) =>
    join(projectPath(projectId), "revisions", `${revision}.json`);
  const commitLockPath = (projectId: string) => join(projectPath(projectId), ".commit.lock");
  const objects = new ContentAddressedStore(options.objectsPath);
  const projectViewsPath = options.projectViewsPath;
  const projectViewLeasesPath = join(dirname(projectViewsPath), "project-view-leases");
  const projectViewLocksPath = join(dirname(projectViewsPath), "project-view-locks");

  const readManifest = async (projectId: string) => {
    try {
      const raw = JSON.parse(await readFile(manifestPath(projectId), "utf8")) as unknown;
      const parsed = ProjectManifestSchema.safeParse(raw);
      if (!parsed.success) {
        throw new PragmaProjectStoreError(
          "unsupported_format",
          "This Desktop project uses an unsupported pre-v2 format. Remove it manually or export it before upgrading.",
        );
      }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const readRevisionManifest = async (projectId: string, revision: number) => {
    try {
      return ProjectRevisionManifestSchema.parse(
        JSON.parse(await readFile(revisionManifestPath(projectId, revision), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const ensureView = async (snapshotHash: string): Promise<string> => {
    const target = join(projectViewsPath, snapshotHash);
    const marker = join(target, ".pragma-snapshot");
    return await withFileLock(
      join(projectViewLocksPath, snapshotHash),
      async () => {
        if (await hasSnapshotMarker(marker, snapshotHash)) return target;
        await rm(target, { recursive: true, force: true });
        const temporary = join(projectViewsPath, `.${snapshotHash}.${randomUUID()}.tmp`);
        await rm(temporary, { recursive: true, force: true });
        await mkdir(temporary, { recursive: true, mode: 0o700 });
        try {
          await objects.materializeTree(snapshotHash, temporary, { touchObjects: true });
          await writeFile(join(temporary, ".pragma-snapshot"), `${snapshotHash}\n`, {
            mode: 0o600,
          });
          await mkdir(projectViewsPath, { recursive: true, mode: 0o700 });
          try {
            await rename(temporary, target);
          } catch (error) {
            const code = errorCode(error);
            if (
              (code !== "EEXIST" && code !== "ENOTEMPTY") ||
              !(await hasSnapshotMarker(marker, snapshotHash))
            ) {
              throw error;
            }
          }
          return target;
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
      { timeoutMs: 30_000, staleMs: 300_000 },
    );
  };

  const location = async (
    projectId: string,
    revision: number,
  ): Promise<PragmaProjectRevisionLocation | undefined> => {
    const manifest = await readRevisionManifest(projectId, revision);
    if (manifest === undefined) return undefined;
    const rootDir = await ensureView(manifest.snapshotHash);
    return {
      projectId,
      revision,
      rootDir,
      entryFile: join(rootDir, "pragma.yaml"),
      snapshotHash: manifest.snapshotHash,
      projectFingerprint: manifest.projectFingerprint,
      compilerVersion: manifest.compilerVersion,
      updatedAt: manifest.createdAt,
    };
  };

  const requireLocation = async (
    projectId: string,
    revision: number,
  ): Promise<PragmaProjectRevisionLocation> => {
    const committed = await location(projectId, revision);
    if (committed === undefined) {
      throw new PragmaProjectStoreError(
        "project_io",
        `Project revision ${projectId}@${revision} was committed but could not be read back.`,
      );
    }
    return committed;
  };

  return {
    async withCheckout(project, operation) {
      const snapshotHash = project.snapshotHash;
      if (snapshotHash === undefined) return await operation(project);
      const leaseDirectory = join(projectViewLeasesPath, snapshotHash);
      const lease = await createProjectViewLease(leaseDirectory);
      try {
        return await operation(project);
      } finally {
        await rm(lease, { force: true });
        await removeEmptyDirectory(leaseDirectory);
      }
    },
    async getHead(projectId) {
      const manifest = await readManifest(projectId);
      return manifest === undefined ? undefined : await location(projectId, manifest.headRevision);
    },
    async getRevision(projectId, revision) {
      if (!Number.isInteger(revision) || revision < 1) return undefined;
      return await location(projectId, revision);
    },
    async readFiles(project) {
      const files = await readTextFiles(project.rootDir);
      return new Map([...files].filter(([path]) => path !== ".pragma-snapshot"));
    },
    async commit(input) {
      return await withFileLock(
        commitLockPath(input.projectId),
        async () => {
          const current = await readManifest(input.projectId);
          const actualRevision = current?.headRevision ?? 0;
          if (actualRevision !== input.expectedRevision) {
            throw new PragmaProjectRevisionConflictError(input.expectedRevision, actualRevision);
          }
          const snapshotFiles = new Map<string, Uint8Array>();
          for (const [relativePath, contents] of input.files) {
            assertProjectRelativePath(relativePath);
            snapshotFiles.set(relativePath, Buffer.from(contents, "utf8"));
          }
          const snapshot = await objects.putSnapshot(snapshotFiles);
          const previous =
            actualRevision === 0
              ? undefined
              : await readRevisionManifest(input.projectId, actualRevision);
          if (input.forceRevision !== true && previous?.snapshotHash === snapshot.root.hash) {
            return await requireLocation(input.projectId, actualRevision);
          }
          const lockSource = input.files.get("pragma.lock.yaml");
          if (lockSource === undefined)
            throw new Error("Project snapshot is missing pragma.lock.yaml.");
          const lock = z
            .object({
              compilerVersion: z.string().min(1),
              projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .passthrough()
            .parse(parsePragmaYaml(lockSource));
          const revision = actualRevision + 1;
          const createdAt = new Date().toISOString();
          const revisionManifest = ProjectRevisionManifestSchema.parse({
            schemaVersion: "pragma.project-revision/v4",
            projectId: input.projectId,
            revision,
            ...(actualRevision === 0 ? {} : { parentRevision: actualRevision }),
            snapshotHash: snapshot.root.hash,
            projectFingerprint: lock.projectFingerprint,
            compilerVersion: lock.compilerVersion,
            createdAt,
          });
          await writeAtomically(
            revisionManifestPath(input.projectId, revision),
            `${JSON.stringify(revisionManifest, undefined, 2)}\n`,
          );
          await writeAtomically(
            manifestPath(input.projectId),
            `${JSON.stringify(
              ProjectManifestSchema.parse({
                schemaVersion: "pragma.desktop-project/v4",
                projectId: input.projectId,
                headRevision: revision,
                updatedAt: createdAt,
              }),
              undefined,
              2,
            )}\n`,
          );
          return await requireLocation(input.projectId, revision);
        },
        { timeoutMs: 30_000, staleMs: 300_000 },
      );
    },
  };
}

async function hasSnapshotMarker(marker: string, snapshotHash: string): Promise<boolean> {
  try {
    return (await readFile(marker, "utf8")).trim() === snapshotHash;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function assertProjectRelativePath(path: string): void {
  const root = resolve("/pragma-desktop-project");
  const target = resolve(root, path);
  const child = relative(root, target);
  if (path.trim() === "" || isAbsolute(path) || child.startsWith("..") || isAbsolute(child)) {
    throw new PragmaProjectStoreError(
      "project_invalid",
      `Project file path escapes its root: ${path}`,
    );
  }
  if (path === ".pragma-snapshot") {
    throw new PragmaProjectStoreError(
      "project_invalid",
      "Project file path is reserved for checkout metadata: .pragma-snapshot",
    );
  }
}

async function readRevisionArtifacts(
  repository: PragmaProjectSourceRepository,
  projectId: string,
  revision: number,
  snapshot: PragmaProjectSnapshot,
): Promise<ReadonlyMap<string, string>> {
  const location = await repository.getRevision(projectId, revision);
  if (location === undefined) return new Map();
  const managed = new Set([
    ".pragma-snapshot",
    "pragma.yaml",
    "pragma.lock.yaml",
    ...(snapshot.lock?.resources.map((resource) => resource.source) ?? []),
    ...snapshot.resources.map(
      (resource) => `${resourceDirectory(resource)}/${resource.metadata.id}.pragma.yaml`,
    ),
  ]);
  return new Map(
    [...(await repository.readFiles(location))].filter(([path]) => !managed.has(path)),
  );
}

function resourceDirectory(resource: PragmaResource): string {
  if (resource.kind === "Expert") return "experts";
  if (resource.kind === "ExpertTeam") return "teams";
  if (resource.kind === "Flow") return "flows";
  if (resource.kind === "Capability") return "capabilities";
  if (resource.kind === "ContextStore") return "context-stores";
  if (resource.kind === "Automation") return "automations";
  return "runtime-profiles";
}

const LegacyProjectManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-project/v3"),
    projectId: z.string().min(1),
    headRevision: z.number().int().positive(),
  })
  .passthrough();

const LegacyProjectRevisionManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.project-revision/v3"),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough();

type LegacyProjectRevision = ReturnType<typeof migratePragmaDslProjectToCurrent>;

async function migrateDesktopProjectStorageV3ToV4(input: {
  readonly projectsPath: string;
  readonly objectsPath: string;
  readonly projectId: string;
  readonly publish: (
    expectedRevision: number,
    resources: readonly PragmaResource[],
    artifacts: ReadonlyMap<string, string>,
  ) => Promise<void>;
}): Promise<void> {
  const projectPath = join(input.projectsPath, input.projectId);
  const manifestPath = join(projectPath, "project.json");
  const journalPath = join(input.projectsPath, `.${input.projectId}.v3-to-v4.json`);
  await withFileLock(`${projectPath}.v3-to-v4.lock`, async () => {
    const pending = await readProjectMigrationJournal(journalPath, input.projectId);
    if (pending !== undefined) {
      if (!(await pathExists(pending.backupPath))) {
        throw new PragmaProjectStoreError(
          "unsupported_format",
          `Cannot recover project migration because its backup is missing: ${pending.backupPath}`,
        );
      }
      await rm(projectPath, { recursive: true, force: true });
      await rename(pending.backupPath, projectPath);
      await rm(journalPath, { force: true });
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (
      typeof rawManifest === "object" &&
      rawManifest !== null &&
      "schemaVersion" in rawManifest &&
      rawManifest.schemaVersion === "pragma.desktop-project/v4"
    ) {
      await rm(journalPath, { force: true });
      return;
    }
    const legacyManifest = LegacyProjectManifestSchema.parse(rawManifest);
    const objects = new ContentAddressedStore(input.objectsPath);
    const revisions: LegacyProjectRevision[] = [];
    for (let revision = 1; revision <= legacyManifest.headRevision; revision += 1) {
      const legacyRevision = LegacyProjectRevisionManifestSchema.parse(
        JSON.parse(
          await readFile(join(projectPath, "revisions", `${revision}.json`), "utf8"),
        ) as unknown,
      );
      const temporary = await mkdtemp(join(input.projectsPath, ".project-v3-view-"));
      try {
        await objects.materializeTree(legacyRevision.snapshotHash, temporary);
        try {
          revisions.push(
            migratePragmaDslProjectToCurrent({
              projectId: input.projectId,
              files: await readTextFiles(temporary),
            }),
          );
        } catch (error) {
          if (error instanceof PragmaDslMigrationError) {
            throw new PragmaProjectStoreError("unsupported_format", error.message);
          }
          throw error;
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    const legacyLayouts = await readOptionalDirectoryFiles(join(projectPath, "layouts"));

    const backupPath = `${projectPath}.v3-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await writeAtomically(
      journalPath,
      `${JSON.stringify(
        {
          schemaVersion: "pragma.desktop-project-migration/v1",
          projectId: input.projectId,
          sourceSchema: "pragma.desktop-project/v3",
          targetSchema: "pragma.desktop-project/v4",
          backupPath,
        },
        undefined,
        2,
      )}\n`,
    );
    await rename(projectPath, backupPath);
    try {
      for (let revision = 0; revision < revisions.length; revision += 1) {
        const migrated = revisions[revision]!;
        await input.publish(revision, migrated.resources, migrated.artifacts);
      }
      await writeLegacyProjectIdentityMigrationIndex(
        projectPath,
        input.projectId,
        revisions.flatMap((revision) => revision.identityMigrations),
      );
      await migrateLegacyFlowLayouts(
        legacyLayouts,
        projectPath,
        revisions.flatMap((revision) => revision.identityMigrations),
      );
      await rm(journalPath, { force: true });
    } catch (error) {
      await rm(projectPath, { recursive: true, force: true });
      await rename(backupPath, projectPath);
      await rm(journalPath, { force: true });
      throw error;
    }
  });
}

async function writeLegacyProjectIdentityMigrationIndex(
  projectPath: string,
  projectId: string,
  identities: readonly {
    readonly kind: PragmaResource["kind"];
    readonly sourceId: string;
    readonly targetId: string;
  }[],
): Promise<void> {
  const unique = new Map<string, (typeof identities)[number]>();
  for (const identity of identities) {
    unique.set(`${identity.kind}:${identity.sourceId}:${identity.targetId}`, identity);
  }
  if (unique.size === 0) return;
  await writeAtomically(
    join(projectPath, "identity-migrations.json"),
    `${JSON.stringify(
      {
        schemaVersion: "pragma.desktop-project-identity-migrations/v1",
        projectId,
        migrations: [...unique.values()],
      },
      undefined,
      2,
    )}\n`,
  );
}

async function readProjectMigrationJournal(
  journalPath: string,
  projectId: string,
): Promise<{ readonly backupPath: string } | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(journalPath, "utf8")) as unknown;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const parsed = z
    .object({
      schemaVersion: z.literal("pragma.desktop-project-migration/v1"),
      projectId: z.literal(projectId),
      sourceSchema: z.literal("pragma.desktop-project/v3"),
      targetSchema: z.literal("pragma.desktop-project/v4"),
      backupPath: z.string().min(1),
    })
    .parse(value);
  return { backupPath: parsed.backupPath };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readOptionalDirectoryFiles(path: string): Promise<ReadonlyMap<string, string>> {
  try {
    return await readTextFiles(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return new Map();
    throw error;
  }
}

async function migrateLegacyFlowLayouts(
  files: ReadonlyMap<string, string>,
  projectPath: string,
  identities: readonly {
    readonly kind: PragmaResource["kind"];
    readonly sourceId: string;
    readonly targetId: string;
  }[],
): Promise<void> {
  const flowIds = new Map(
    identities
      .filter((identity) => identity.kind === "Flow")
      .map((identity) => [identity.sourceId, identity.targetId]),
  );
  for (const source of files.values()) {
    const value = JSON.parse(source) as Record<string, unknown>;
    if (
      value["schemaVersion"] !== "pragma.desktop-flow-layout/v1" ||
      typeof value["flowId"] !== "string"
    ) {
      continue;
    }
    const flowId = flowIds.get(value["flowId"]);
    if (flowId === undefined) continue;
    delete value["flowVersion"];
    value["schemaVersion"] = "pragma.desktop-flow-layout/v2";
    value["flowId"] = flowId;
    await writeAtomically(
      join(projectPath, "layouts", "flows", `${flowId}.json`),
      `${JSON.stringify(value, undefined, 2)}\n`,
    );
  }
}

async function readTextFiles(root: string, base = root): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [child, contents] of await readTextFiles(path, base)) files.set(child, contents);
    } else if (entry.isFile()) {
      files.set(relative(base, path).split(sep).join("/"), await readFile(path, "utf8"));
    }
  }
  return files;
}

async function createProjectViewLease(directory: string): Promise<string> {
  while (true) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      // A concurrent checkout may remove the empty lease directory while mkdir is
      // still resolving it. Retry the same way we do when the lease write loses
      // that race.
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const lease = join(directory, `${randomUUID()}.lease`);
    try {
      await writeFile(
        lease,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      return lease;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "EINVAL") throw error;
    }
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function issuesToDiagnostics(issues: readonly z.core.$ZodIssue[]): PragmaDiagnostic[] {
  return issues.map((issue) =>
    PragmaDiagnosticSchema.parse({
      severity: "error",
      code: "schema.invalid",
      message: issue.message,
      path: issue.path.map((segment) =>
        typeof segment === "symbol" ? (segment.description ?? "symbol") : segment,
      ),
    }),
  );
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, path);
}
