import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  PragmaProjectRevisionConflictError,
  PragmaProjectService,
  PragmaProjectValidationError,
  formatPragmaYaml,
  loadPragmaProject,
  parsePragmaYaml,
  type PragmaProject,
  type PragmaProjectRevisionLocation,
  type PragmaProjectSourceRepository,
} from "@pragma/interpreter";
import {
  PragmaDiagnosticSchema,
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
  remove(input: {
    readonly expectedRevision: number;
    readonly ref: string;
  }): Promise<PragmaProjectSnapshot>;
  validateYaml(source: string): Promise<PragmaYamlValidationResult>;
  validateCandidate(input: {
    readonly expectedRevision: number;
    readonly resource: PragmaResource;
  }): Promise<PragmaYamlValidationResult>;
  openRevision(revision: number): Promise<PragmaProject>;
  readonly service: PragmaProjectService;
  readonly projectId: string;
}

export class PragmaProjectStoreError extends Error {
  constructor(
    readonly code:
      | "project_invalid"
      | "revision_conflict"
      | "resource_not_found"
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

  return {
    projectId,
    service,
    get,
    async publish(input) {
      try {
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
      try {
        return PragmaProjectSnapshotSchema.parse(
          await service.apply({
            projectId,
            expectedRevision: input.expectedRevision,
            upserts: [input.resource],
          }),
        );
      } catch (error) {
        return normalizeError(error);
      }
    },
    async remove(input) {
      const snapshot = await get();
      if (
        !snapshot.resources.some((resource) => canonicalPragmaResourceRef(resource) === input.ref)
      ) {
        throw new PragmaProjectStoreError("resource_not_found", `Resource not found: ${input.ref}`);
      }
      try {
        return PragmaProjectSnapshotSchema.parse(
          await service.apply({
            projectId,
            expectedRevision: input.expectedRevision,
            removals: [input.ref],
          }),
        );
      } catch (error) {
        return normalizeError(error);
      }
    },
    async validateYaml(source) {
      try {
        const parsed = PragmaResourceSchema.safeParse(parsePragmaYaml(source));
        if (!parsed.success) return { diagnostics: issuesToDiagnostics(parsed.error.issues) };
        const diagnostics = await service.validate({ resources: [parsed.data] });
        return { resource: parsed.data, diagnostics: [...diagnostics] };
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
          ...(await service.validateCandidate({
            projectId,
            expectedRevision: input.expectedRevision,
            upserts: [resource],
          })),
        ],
      };
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
      files.set(path.slice(base.length + 1), await readFile(path, "utf8"));
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
