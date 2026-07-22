import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  PragmaProjectRevisionConflictError,
  PragmaProjectService,
  PragmaProjectValidationError,
  formatPragmaYaml,
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
import { withFileLock } from "@pragma/core";

import {
  PragmaProjectSnapshotSchema,
  type PragmaProjectSnapshot,
  type PragmaYamlValidationResult,
} from "../shared/desktop-api.ts";
import { referencingPragmaResources } from "./pragma-resource-references.ts";

const ProjectManifestSchema = z
  .object({
    apiVersion: z.literal("pragma/v2"),
    kind: z.literal("DesktopProject"),
    projectId: z.string().min(1),
    revision: z.number().int().positive(),
    entry: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export interface PragmaProjectStore {
  get(): Promise<PragmaProjectSnapshot>;
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
  readonly projectId?: string;
  readonly reservedResourceRefs?: ReadonlySet<string> | undefined;
}): PragmaProjectStore {
  const projectId = options.projectId ?? "studio";
  const repository = createDesktopProjectSourceRepository({
    projectsPath: options.projectsPath,
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

  return {
    projectId,
    get,
    async publish(input) {
      try {
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
    },
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
}): PragmaProjectSourceRepository {
  const projectPath = (projectId: string) => join(options.projectsPath, projectId);
  const manifestPath = (projectId: string) => join(projectPath(projectId), "manifest.yaml");
  const commitLockPath = (projectId: string) => join(projectPath(projectId), ".commit.lock");

  const readManifest = async (projectId: string) => {
    try {
      const raw = parsePragmaYaml(await readFile(manifestPath(projectId), "utf8"));
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

  const location = (
    projectId: string,
    revision: number,
    updatedAt?: string,
  ): PragmaProjectRevisionLocation => ({
    projectId,
    revision,
    rootDir: join(projectPath(projectId), `revisions/${revision}`),
    entryFile: join(projectPath(projectId), `revisions/${revision}/pragma.yaml`),
    updatedAt,
  });

  return {
    async getHead(projectId) {
      const manifest = await readManifest(projectId);
      return manifest === undefined
        ? undefined
        : location(projectId, manifest.revision, manifest.updatedAt);
    },
    async getRevision(projectId, revision) {
      if (!Number.isInteger(revision) || revision < 1) return undefined;
      try {
        await readFile(join(projectPath(projectId), `revisions/${revision}/pragma.yaml`), "utf8");
        return location(projectId, revision);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async readFiles(project) {
      return await readTextFiles(project.rootDir);
    },
    async commit(input) {
      return await withFileLock(
        commitLockPath(input.projectId),
        async () => {
          const current = await readManifest(input.projectId);
          const actualRevision = current?.revision ?? 0;
          if (actualRevision !== input.expectedRevision) {
            throw new PragmaProjectRevisionConflictError(input.expectedRevision, actualRevision);
          }
          const revision = actualRevision + 1;
          const projectRoot = projectPath(input.projectId);
          const temporaryPath = join(projectRoot, `.revision-${revision}-${randomUUID()}.tmp`);
          const targetPath = join(projectRoot, `revisions/${revision}`);
          await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
          try {
            for (const [relativePath, contents] of input.files) {
              assertProjectRelativePath(relativePath);
              const target = join(temporaryPath, relativePath);
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              await writeFile(target, contents, { mode: 0o600 });
            }
            await mkdir(join(projectRoot, "revisions"), { recursive: true, mode: 0o700 });
            await rm(targetPath, { recursive: true, force: true });
            await rename(temporaryPath, targetPath);
            const updatedAt = new Date().toISOString();
            await writeAtomically(
              manifestPath(input.projectId),
              formatPragmaYaml({
                apiVersion: "pragma/v2",
                kind: "DesktopProject",
                projectId: input.projectId,
                revision,
                entry: `revisions/${revision}/pragma.yaml`,
                updatedAt,
              }),
            );
            return location(input.projectId, revision, updatedAt);
          } catch (error) {
            await rm(temporaryPath, { recursive: true, force: true });
            throw error;
          }
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
