import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { ContentAddressedStore, withFileLock } from "@pragma/core";
import {
  loadPragmaProject,
  type PragmaProject,
  type PragmaProjectRevisionLocation,
  type PragmaProjectSourceRepository,
} from "@pragma/interpreter";

/** The current published project manifests shared by Host implementations. */
export const LocalHostProjectManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-project/v5"),
    projectId: z.string().min(1),
    headRevision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const LocalHostProjectRevisionManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.project-revision/v5"),
    projectId: z.string().min(1),
    revision: z.number().int().positive(),
    parentRevision: z.number().int().positive().optional(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    compilerVersion: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type LocalHostProjectManifest = z.infer<typeof LocalHostProjectManifestSchema>;
export type LocalHostProjectRevisionManifest = z.infer<
  typeof LocalHostProjectRevisionManifestSchema
>;

export interface LocalHostProjectRevisionReader {
  readonly getHead: (projectId: string) => Promise<PragmaProjectRevisionLocation | undefined>;
  readonly getRevision: (
    projectId: string,
    revision: number,
  ) => Promise<PragmaProjectRevisionLocation | undefined>;
  readonly openRevision: (location: PragmaProjectRevisionLocation) => Promise<PragmaProject>;
  readonly readFiles: (
    location: PragmaProjectRevisionLocation,
  ) => Promise<ReadonlyMap<string, string>>;
}

/**
 * Read-only adapter for the published project/revision store.
 *
 * It owns only the Host-neutral current manifest contract and derives all
 * storage locations from injected roots. It does not perform migrations,
 * scan projects, or import Desktop feature code.
 */
export function createLocalHostProjectRevisionReader(options: {
  readonly projectsPath: string;
  readonly objectsPath: string;
  readonly projectViewsPath: string;
}): LocalHostProjectRevisionReader {
  const objects = new ContentAddressedStore(options.objectsPath);
  const projectViewLocksPath = join(dirname(options.projectViewsPath), "project-view-locks");
  // Project IDs are Host-owned project directory names in the existing v5
  // store (unlike Core session/execution IDs, which use encoded segments).
  const projectPath = (projectId: string): string => join(options.projectsPath, projectId);
  const manifestPath = (projectId: string): string => join(projectPath(projectId), "project.json");
  const revisionManifestPath = (projectId: string, revision: number): string =>
    join(projectPath(projectId), "revisions", `${revision}.json`);

  const readProjectManifest = async (
    projectId: string,
  ): Promise<LocalHostProjectManifest | undefined> => {
    const raw = await readJsonIfPresent(manifestPath(projectId));
    if (raw === undefined) return undefined;
    const manifest = LocalHostProjectManifestSchema.parse(raw);
    if (manifest.projectId !== projectId) {
      throw new Error(`Project manifest identity mismatch: ${projectId}.`);
    }
    return manifest;
  };

  const readRevisionManifest = async (
    projectId: string,
    revision: number,
  ): Promise<LocalHostProjectRevisionManifest | undefined> => {
    if (!Number.isInteger(revision) || revision < 1) return undefined;
    const raw = await readJsonIfPresent(revisionManifestPath(projectId, revision));
    if (raw === undefined) return undefined;
    const manifest = LocalHostProjectRevisionManifestSchema.parse(raw);
    if (manifest.projectId !== projectId || manifest.revision !== revision) {
      throw new Error(`Project revision manifest identity mismatch: ${projectId}@${revision}.`);
    }
    return manifest;
  };

  const ensureView = async (snapshotHash: string): Promise<string> => {
    const target = join(options.projectViewsPath, snapshotHash);
    const marker = join(target, ".pragma-snapshot");
    return await withFileLock(
      join(projectViewLocksPath, snapshotHash),
      async () => {
        if (await hasSnapshotMarker(marker, snapshotHash)) return target;
        await rm(target, { recursive: true, force: true });
        const temporary = join(options.projectViewsPath, `.${snapshotHash}.${randomUUID()}.tmp`);
        await rm(temporary, { recursive: true, force: true });
        await mkdir(temporary, { recursive: true, mode: 0o700 });
        try {
          await objects.materializeTree(snapshotHash, temporary, { touchObjects: true });
          await writeFile(join(temporary, ".pragma-snapshot"), `${snapshotHash}\n`, {
            mode: 0o600,
          });
          await mkdir(options.projectViewsPath, { recursive: true, mode: 0o700 });
          try {
            await rename(temporary, target);
          } catch (error) {
            if (!isAlreadyExists(error) || !(await hasSnapshotMarker(marker, snapshotHash))) {
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

  const toLocation = async (
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

  const sourceRepository: PragmaProjectSourceRepository = {
    getHead: async (projectId) => {
      const manifest = await readProjectManifest(projectId);
      return manifest === undefined
        ? undefined
        : await toLocation(projectId, manifest.headRevision);
    },
    getRevision: async (projectId, revision) => await toLocation(projectId, revision),
    readFiles: async (location) => await readTextFiles(location.rootDir),
    commit: async () => {
      throw new Error("The Local Host project revision reader is read-only.");
    },
  };

  return {
    getHead: sourceRepository.getHead,
    getRevision: sourceRepository.getRevision,
    readFiles: sourceRepository.readFiles,
    openRevision: async (location) =>
      await loadPragmaProject(location.entryFile, {
        rootDir: location.rootDir,
        requireLock: true,
        ...(location.compilerVersion === undefined
          ? {}
          : { revisionCompilerVersion: location.compilerVersion }),
        ...(location.snapshotHash === undefined ? {} : { sourceIdentity: location.snapshotHash }),
      }),
  };
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function hasSnapshotMarker(path: string, snapshotHash: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).trim() === snapshotHash;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readTextFiles(rootDir: string): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else if (entry.isFile() && entry.name !== ".pragma-snapshot") {
        files.set(relativePath, await readFile(path, "utf8"));
      }
    }
  };
  await visit(rootDir, "");
  return files;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}
