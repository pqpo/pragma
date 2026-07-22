import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  PragmaProjectRevisionConflictError,
  PragmaProjectService,
  PragmaProjectValidationError,
  loadPragmaProject,
  parsePragmaYaml,
  type PragmaProject,
  type CompiledResource,
  type InvocableResource,
  type PragmaProjectRevisionLocation,
  type PragmaProjectSourceRepository,
} from "@pragma/interpreter";
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
    schemaVersion: z.literal("pragma.desktop-project/v3"),
    projectId: z.string().min(1),
    headRevision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const ProjectRevisionManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.project-revision/v3"),
    projectId: z.string().min(1),
    revision: z.number().int().positive(),
    parentRevision: z.number().int().positive().optional(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    compilerVersion: z.string().min(1),
    createdAt: z.string().datetime(),
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
    readonly expectedRevision: number;
    readonly resource: PragmaResource;
  }): Promise<PragmaProjectSnapshot>;
  apply(input: {
    readonly expectedRevision: number;
    readonly upserts: readonly PragmaResource[];
    readonly removals?: readonly string[] | undefined;
  }): Promise<PragmaProjectSnapshot>;
  remove(input: {
    readonly expectedRevision: number;
    readonly ref: string;
  }): Promise<PragmaProjectSnapshot>;
  validateYaml(source: string): Promise<PragmaYamlValidationResult>;
  validateCandidate(input: {
    readonly expectedRevision: number;
    readonly resource: PragmaResource;
  }): Promise<PragmaYamlValidationResult>;
  validateChanges(input: {
    readonly expectedRevision: number;
    readonly upserts: readonly PragmaResource[];
    readonly removals?: readonly string[] | undefined;
  }): Promise<readonly PragmaDiagnostic[]>;
  compile<T extends InvocableResource>(
    input: Parameters<PragmaProjectService["compile"]>[0],
  ): Promise<CompiledResource<T>>;
  openRevision(revision: number): Promise<PragmaProject>;
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
}): PragmaProjectStore {
  const projectId = options.projectId ?? "studio";
  const repository = createDesktopProjectSourceRepository({
    projectsPath: options.projectsPath,
    objectsPath: options.objectsPath ?? join(options.projectsPath, ".storage", "objects"),
    projectViewsPath: options.projectViewsPath ?? join(options.projectsPath, ".cache", "views"),
  });
  const service = new PragmaProjectService({ repository });

  const get = async (): Promise<PragmaProjectSnapshot> =>
    PragmaProjectSnapshotSchema.parse(await service.get(projectId));

  const normalizeError = (error: unknown): never => {
    if (error instanceof PragmaProjectRevisionConflictError) {
      throw new PragmaProjectStoreError("revision_conflict", error.message);
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

  const materializeCandidate = async (input: {
    readonly expectedRevision: number;
    readonly upserts?: readonly PragmaResource[] | undefined;
    readonly removals?: readonly string[] | undefined;
  }): Promise<readonly PragmaResource[]> => {
    const current = await get();
    if (current.revision !== input.expectedRevision) {
      throw new PragmaProjectStoreError(
        "revision_conflict",
        `Pragma project revision conflict: expected ${input.expectedRevision}, got ${current.revision}.`,
      );
    }
    const upserts = (input.upserts ?? []).map((resource) => PragmaResourceSchema.parse(resource));
    const removals = new Set(input.removals ?? []);
    const upsertRefs = new Set(upserts.map(canonicalPragmaResourceRef));
    return [
      ...current.resources.filter((resource) => {
        const ref = canonicalPragmaResourceRef(resource);
        return !removals.has(ref) && !upsertRefs.has(ref);
      }),
      ...upserts,
    ];
  };

  const validateChanges = async (input: {
    readonly expectedRevision: number;
    readonly upserts: readonly PragmaResource[];
    readonly removals?: readonly string[] | undefined;
  }): Promise<readonly PragmaDiagnostic[]> => {
    const resources = await materializeCandidate(input);
    return [
      ...desktopExpertAuthoringDiagnostics(resources),
      ...(await service.validateCandidate({ projectId, ...input })),
    ];
  };

  const apply = async (input: {
    readonly expectedRevision: number;
    readonly upserts: readonly PragmaResource[];
    readonly removals?: readonly string[] | undefined;
  }): Promise<PragmaProjectSnapshot> => {
    try {
      if (options.storagePaths !== undefined) await assertStorageWriteAllowed(options.storagePaths);
      assertNotReserved(input.upserts);
      if (input.removals?.some((ref) => options.reservedResourceRefs?.has(ref)) === true) {
        throw new PragmaProjectStoreError(
          "built_in_readonly",
          "Built-in resource refs cannot be removed.",
        );
      }
      const resources = await materializeCandidate(input);
      assertDesktopExpertAuthoring(resources);
      return PragmaProjectSnapshotSchema.parse(
        await service.apply({ projectId, ...input, removals: input.removals ?? [] }),
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
      return await apply({ expectedRevision: input.expectedRevision, upserts: [input.resource] });
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
        expectedRevision: input.expectedRevision,
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
            expectedRevision: input.expectedRevision,
            upserts: [resource],
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
    try {
      if ((await readFile(marker, "utf8")).trim() === snapshotHash) return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(projectViewsPath, `.${snapshotHash}.${randomUUID()}.tmp`);
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      await objects.materializeTree(snapshotHash, temporary, { touchObjects: true });
      await writeFile(join(temporary, ".pragma-snapshot"), `${snapshotHash}\n`, { mode: 0o600 });
      await mkdir(projectViewsPath, { recursive: true, mode: 0o700 });
      try {
        await rename(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return target;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
          if (previous?.snapshotHash === snapshot.root.hash) {
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
            schemaVersion: "pragma.project-revision/v3",
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
                schemaVersion: "pragma.desktop-project/v3",
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
      (resource) =>
        `${resourceDirectory(resource)}/${resource.metadata.id}@${resource.metadata.version}.pragma.yaml`,
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
  return "runtime-profiles";
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
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lease = join(directory, `${randomUUID()}.lease`);
    try {
      await writeFile(
        lease,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      return lease;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
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
