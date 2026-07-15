import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatPragmaYaml,
  loadPragmaProject,
  parsePragmaYaml,
  type PragmaProject,
} from "@pragma/interpreter";
import {
  PragmaDiagnosticSchema,
  PragmaResourceSchema,
  type PragmaDiagnostic,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { z } from "zod";

import {
  PragmaProjectSnapshotSchema,
  type PragmaProjectSnapshot,
  type PragmaYamlValidationResult,
} from "../shared/desktop-api.ts";

const ProjectManifestSchema = z.object({
  apiVersion: z.literal("pragma/v1"),
  kind: z.literal("DesktopProject"),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  entry: z.string().min(1),
  updatedAt: z.string().datetime(),
});

export interface PragmaProjectStore {
  get(): Promise<PragmaProjectSnapshot>;
  publish(input: {
    readonly expectedRevision: number;
    readonly resources: readonly PragmaResource[];
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
  openRevision(revision: number): Promise<PragmaProject>;
}

export class PragmaProjectStoreError extends Error {
  constructor(
    readonly code: "revision_conflict" | "resource_not_found" | "project_invalid",
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
  const projectPath = join(options.projectsPath, projectId);
  const manifestPath = join(projectPath, "manifest.yaml");
  let writeQueue = Promise.resolve();

  const readManifest = async () => {
    try {
      return ProjectManifestSchema.parse(parsePragmaYaml(await readFile(manifestPath, "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  };

  const readSnapshot = async (): Promise<PragmaProjectSnapshot> => {
    const manifest = await readManifest();
    if (manifest === undefined) {
      return PragmaProjectSnapshotSchema.parse({
        schemaVersion: "pragma.desktop-project/v1",
        projectId,
        revision: 0,
        resources: [],
        diagnostics: [],
      });
    }
    const entry = join(projectPath, manifest.entry);
    const project = await loadPragmaProject(entry, { rootDir: projectPath });
    return PragmaProjectSnapshotSchema.parse({
      schemaVersion: "pragma.desktop-project/v1",
      projectId,
      revision: manifest.revision,
      resources: project.listResources(),
      diagnostics: await project.validate(),
      lock: project.createLock(),
      updatedAt: manifest.updatedAt,
    });
  };

  const serializeWrite = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = writeQueue;
    let release: () => void = () => undefined;
    writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const publish = async (input: {
    readonly expectedRevision: number;
    readonly resources: readonly PragmaResource[];
  }): Promise<PragmaProjectSnapshot> =>
    await serializeWrite(async () => {
      const current = await readSnapshot();
      if (current.revision !== input.expectedRevision) {
        throw new PragmaProjectStoreError(
          "revision_conflict",
          `Project revision changed from ${input.expectedRevision} to ${current.revision}.`,
        );
      }
      const resources = input.resources.map((resource) => PragmaResourceSchema.parse(resource));
      assertUniqueResources(resources);
      const revision = current.revision + 1;
      const temporaryPath = join(projectPath, `.revision-${revision}-${randomUUID()}.tmp`);
      const revisionName = `revisions/${revision}`;
      const targetPath = join(projectPath, revisionName);
      let targetInstalled = false;
      let manifestCommitted = false;
      await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
      try {
        const imports: string[] = [];
        for (const resource of resources) {
          const directory = `${resourceKind(resource)}s`;
          const relativePath = `${directory}/${resource.metadata.id}.pragma.yaml`;
          imports.push(relativePath);
          await mkdir(join(temporaryPath, directory), { recursive: true, mode: 0o700 });
          await writeFile(join(temporaryPath, relativePath), formatPragmaYaml(resource), {
            mode: 0o600,
          });
        }
        await writeFile(
          join(temporaryPath, "pragma.yaml"),
          formatPragmaYaml({ apiVersion: "pragma/v1", kind: "Bundle", imports, resources: [] }),
          { mode: 0o600 },
        );
        const stagedProject = await loadPragmaProject(join(temporaryPath, "pragma.yaml"), {
          rootDir: temporaryPath,
        });
        const diagnostics = await stagedProject.validate();
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length > 0) {
          throw new PragmaProjectStoreError(
            "project_invalid",
            "The Pragma project has validation errors.",
            errors,
          );
        }
        await writeFile(
          join(temporaryPath, "pragma.lock.yaml"),
          formatPragmaYaml(stagedProject.createLock()),
          { mode: 0o600 },
        );
        await mkdir(join(projectPath, "revisions"), { recursive: true, mode: 0o700 });
        // The manifest is the commit marker. A prior crash may have left this unpublished
        // revision directory behind, so it is safe to remove before installing the next attempt.
        await rm(targetPath, { recursive: true, force: true });
        await rename(temporaryPath, targetPath);
        targetInstalled = true;
        const updatedAt = new Date().toISOString();
        await writeAtomically(
          manifestPath,
          formatPragmaYaml({
            apiVersion: "pragma/v1",
            kind: "DesktopProject",
            projectId,
            revision,
            entry: `${revisionName}/pragma.yaml`,
            updatedAt,
          }),
        );
        manifestCommitted = true;
        return await readSnapshot();
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        if (targetInstalled && !manifestCommitted) {
          await rm(targetPath, { recursive: true, force: true });
        }
        throw error;
      }
    });

  return {
    get: readSnapshot,
    publish,
    async upsert(input) {
      const snapshot = await readSnapshot();
      if (snapshot.revision !== input.expectedRevision) {
        throw new PragmaProjectStoreError(
          "revision_conflict",
          `Project revision changed from ${input.expectedRevision} to ${snapshot.revision}.`,
        );
      }
      const resource = PragmaResourceSchema.parse(input.resource);
      const key = resourceKey(resource);
      return await publish({
        expectedRevision: input.expectedRevision,
        resources: [
          ...snapshot.resources.filter((current) => resourceKey(current) !== key),
          resource,
        ],
      });
    },
    async remove(input) {
      const snapshot = await readSnapshot();
      if (snapshot.revision !== input.expectedRevision) {
        throw new PragmaProjectStoreError(
          "revision_conflict",
          `Project revision changed from ${input.expectedRevision} to ${snapshot.revision}.`,
        );
      }
      const resources = snapshot.resources.filter(
        (resource) => canonicalRef(resource) !== input.ref,
      );
      if (resources.length === snapshot.resources.length) {
        throw new PragmaProjectStoreError("resource_not_found", `Resource not found: ${input.ref}`);
      }
      return await publish({ expectedRevision: input.expectedRevision, resources });
    },
    async validateYaml(source) {
      try {
        const parsed = PragmaResourceSchema.safeParse(parsePragmaYaml(source));
        if (parsed.success) return { resource: parsed.data, diagnostics: [] };
        return {
          diagnostics: parsed.error.issues.map((issue) =>
            PragmaDiagnosticSchema.parse({
              severity: "error",
              code: "schema.invalid",
              message: issue.message,
              path: issue.path,
            }),
          ),
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
    async openRevision(revision) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new PragmaProjectStoreError(
          "project_invalid",
          `Invalid project revision: ${revision}`,
        );
      }
      return await loadPragmaProject(join(projectPath, `revisions/${revision}/pragma.yaml`), {
        rootDir: projectPath,
        requireLock: true,
      });
    },
  };
}

function resourceKind(resource: PragmaResource): "expert" | "team" | "flow" {
  return resource.kind === "Expert" ? "expert" : resource.kind === "ExpertTeam" ? "team" : "flow";
}

function resourceKey(resource: PragmaResource): string {
  return `${resourceKind(resource)}:${resource.metadata.id}`;
}

function canonicalRef(resource: PragmaResource): string {
  return `${resourceKey(resource)}@${resource.metadata.version}`;
}

function assertUniqueResources(resources: readonly PragmaResource[]): void {
  const keys = new Set<string>();
  for (const resource of resources) {
    const key = resourceKey(resource);
    if (keys.has(key)) {
      throw new PragmaProjectStoreError("project_invalid", `Duplicate resource: ${key}`);
    }
    keys.add(key);
  }
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
