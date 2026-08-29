import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import { ContentAddressedStore, withFileLock } from "@pragma/core";
import {
  PRAGMA_COMPILER_MIGRATION_CHAIN_VERSION,
  PRAGMA_COMPILER_WRITE_VERSION,
  PragmaCompilerMigrationError,
  PragmaLockSchema,
  PragmaProjectService,
  isPragmaCompilerVersionDirectlyReadable,
  isPragmaCompilerVersionUpgradeable,
  loadPragmaProject,
  migratePragmaCompilerProjectToCurrent,
  parsePragmaYaml,
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

/**
 * Additional metadata carried only by a Local Host compiler view.
 *
 * `projectFingerprint` remains the immutable source fingerprint from the
 * published Revision manifest.  A compiler migration may produce a different
 * target fingerprint; it is intentionally kept separate and never written
 * back to the Revision manifest or its lock.
 */
export interface LocalHostProjectRevisionLocation extends PragmaProjectRevisionLocation {
  readonly sourceProjectFingerprint?: string | undefined;
  readonly sourceCompilerVersion?: string | undefined;
  readonly compilerViewKey?: string | undefined;
  readonly derivedProjectFingerprint?: string | undefined;
}

export interface LocalHostProjectRevisionReader {
  readonly getHead: (projectId: string) => Promise<LocalHostProjectRevisionLocation | undefined>;
  readonly getRevision: (
    projectId: string,
    revision: number,
  ) => Promise<LocalHostProjectRevisionLocation | undefined>;
  readonly openRevision: (location: LocalHostProjectRevisionLocation) => Promise<PragmaProject>;
  readonly readFiles: (
    location: LocalHostProjectRevisionLocation,
  ) => Promise<ReadonlyMap<string, string>>;
}

const COMPILER_VIEW_MARKER = ".pragma-compiler-view" as const;
const CompilerViewMetadataSchema = z
  .object({
    format: z.literal("pragma.local-host.compiler-view/v1"),
    cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceProjectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCompilerVersion: z.string().min(1),
    targetCompilerVersion: z.literal(PRAGMA_COMPILER_WRITE_VERSION),
    migrationChainVersion: z.literal(PRAGMA_COMPILER_MIGRATION_CHAIN_VERSION),
    derivedProjectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type CompilerViewMetadata = z.infer<typeof CompilerViewMetadataSchema>;

/**
 * Read-only adapter for the published project/revision store.
 *
 * It owns only the Host-neutral current manifest contract and derives all
 * storage locations from injected roots. Legacy compiler revisions are
 * upgraded into rebuildable derived views on first access; authority files are
 * never rewritten and no project history is scanned during construction.
 */
export function createLocalHostProjectRevisionReader(options: {
  readonly projectsPath: string;
  readonly objectsPath: string;
  readonly projectViewsPath: string;
}): LocalHostProjectRevisionReader {
  const objects = new ContentAddressedStore(options.objectsPath);
  const projectViewLocksPath = join(dirname(options.projectViewsPath), "project-view-locks");
  const compilerViewLocksPath = join(
    dirname(options.projectViewsPath),
    "project-compiler-view-locks",
  );
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

  const sourceRepository: PragmaProjectSourceRepository = {
    getHead: async (projectId) => {
      const manifest = await readProjectManifest(projectId);
      return manifest === undefined
        ? undefined
        : await toLocation(projectId, manifest.headRevision);
    },
    getRevision: async (projectId, revision) => await toLocation(projectId, revision),
    readFiles: async (location) =>
      await readTextFiles(location.rootDir, isCompilerViewLocation(location)),
    commit: async () => {
      throw new Error("The Local Host project revision reader is read-only.");
    },
  };
  const migrationRenderer = new PragmaProjectService({ repository: sourceRepository });

  const toLocation = async (
    projectId: string,
    revision: number,
  ): Promise<LocalHostProjectRevisionLocation | undefined> => {
    const manifest = await readRevisionManifest(projectId, revision);
    if (manifest === undefined) return undefined;
    const rootDir = await ensureView(manifest.snapshotHash);
    const sourceLocation: LocalHostProjectRevisionLocation = {
      projectId,
      revision,
      rootDir,
      entryFile: join(rootDir, "pragma.yaml"),
      snapshotHash: manifest.snapshotHash,
      projectFingerprint: manifest.projectFingerprint,
      compilerVersion: manifest.compilerVersion,
      updatedAt: manifest.createdAt,
      sourceProjectFingerprint: manifest.projectFingerprint,
      sourceCompilerVersion: manifest.compilerVersion,
    };
    return await ensureCompilerView(sourceLocation);
  };

  return {
    getHead: sourceRepository.getHead,
    getRevision: sourceRepository.getRevision,
    readFiles: sourceRepository.readFiles,
    openRevision: async (location) => {
      const project = await loadPragmaProject(location.entryFile, {
        rootDir: location.rootDir,
        requireLock: true,
        ...(location.compilerVersion === undefined
          ? {}
          : { revisionCompilerVersion: location.compilerVersion }),
        ...(location.compilerViewKey !== undefined
          ? { sourceIdentity: location.compilerViewKey }
          : location.snapshotHash === undefined
            ? location.projectFingerprint === undefined
              ? {}
              : { sourceIdentity: location.projectFingerprint }
            : { sourceIdentity: location.snapshotHash }),
      });
      try {
        const compiledFingerprint = project.createLock().projectFingerprint;
        const expectedFingerprint =
          location.derivedProjectFingerprint ?? location.projectFingerprint;
        if (expectedFingerprint !== undefined && compiledFingerprint !== expectedFingerprint) {
          throw new Error(
            `Compiled project fingerprint does not match the ${
              location.derivedProjectFingerprint === undefined
                ? "published"
                : "derived compiler view"
            } revision: ${location.projectId}@${location.revision}.`,
          );
        }
        return project;
      } catch (error) {
        await project.dispose();
        throw error;
      }
    },
  };

  async function ensureCompilerView(
    location: LocalHostProjectRevisionLocation,
  ): Promise<LocalHostProjectRevisionLocation> {
    const sourceCompilerVersion = location.sourceCompilerVersion ?? location.compilerVersion;
    if (sourceCompilerVersion === undefined) {
      throw new PragmaCompilerMigrationError(
        "missing_migration_step",
        `Project revision ${location.projectId}@${location.revision} does not declare a compiler version.`,
      );
    }
    if (isPragmaCompilerVersionDirectlyReadable(sourceCompilerVersion)) return location;
    if (!isPragmaCompilerVersionUpgradeable(sourceCompilerVersion)) {
      throw unsupportedCompilerVersion(sourceCompilerVersion);
    }
    if (location.snapshotHash === undefined || location.projectFingerprint === undefined) {
      throw new Error(
        `Project revision ${location.projectId}@${location.revision} has no immutable compiler view identity.`,
      );
    }

    const cacheKey = createCompilerViewKey({
      sourceSnapshotHash: location.snapshotHash,
      sourceProjectFingerprint: location.projectFingerprint,
      sourceCompilerVersion,
    });
    const target = join(options.projectViewsPath, `compiler-${cacheKey}`);
    const marker = join(target, COMPILER_VIEW_MARKER);
    const expectedMetadata: Omit<CompilerViewMetadata, "derivedProjectFingerprint"> = {
      format: "pragma.local-host.compiler-view/v1" as const,
      cacheKey,
      sourceSnapshotHash: location.snapshotHash,
      sourceProjectFingerprint: location.projectFingerprint,
      sourceCompilerVersion,
      targetCompilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
      migrationChainVersion: PRAGMA_COMPILER_MIGRATION_CHAIN_VERSION,
    };

    const existing = await readCompilerViewMetadata(marker);
    if (isMatchingCompilerView(existing, expectedMetadata)) {
      return compilerViewLocation(location, target, existing);
    }

    await withFileLock(
      join(compilerViewLocksPath, cacheKey),
      async () => {
        const lockedExisting = await readCompilerViewMetadata(marker);
        if (isMatchingCompilerView(lockedExisting, expectedMetadata)) return;

        const migration = migratePragmaCompilerProjectToCurrent({
          files: await readTextFiles(location.rootDir),
          revisionCompilerVersion: sourceCompilerVersion,
        });
        const files = await migrationRenderer.renderCompilerMigration(migration);
        if (files.has(COMPILER_VIEW_MARKER)) {
          throw new Error(
            `Project revision ${location.projectId}@${location.revision} uses the reserved compiler view metadata path: ${COMPILER_VIEW_MARKER}.`,
          );
        }
        const lockSource = files.get("pragma.lock.yaml");
        if (lockSource === undefined) {
          throw new Error("Compiler migration did not produce pragma.lock.yaml.");
        }
        const targetLock = PragmaLockSchema.parse(parsePragmaYaml(lockSource));
        if (targetLock.compilerVersion !== migration.targetCompilerVersion) {
          throw new Error("Compiler migration produced a lock for an unexpected compiler version.");
        }
        const metadata: CompilerViewMetadata = {
          ...expectedMetadata,
          derivedProjectFingerprint: targetLock.projectFingerprint,
        };
        await publishCompilerView({ target, cacheKey, files, metadata });
      },
      { timeoutMs: 30_000, staleMs: 300_000 },
    );

    const metadata = await readCompilerViewMetadata(marker);
    if (!isMatchingCompilerView(metadata, expectedMetadata)) {
      throw new Error(
        `Compiler view for ${location.projectId}@${location.revision} was not published completely.`,
      );
    }
    return compilerViewLocation(location, target, metadata);
  }
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

async function readTextFiles(
  rootDir: string,
  excludeCompilerViewMarker = false,
): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else if (
        entry.isFile() &&
        entry.name !== ".pragma-snapshot" &&
        (!excludeCompilerViewMarker || entry.name !== COMPILER_VIEW_MARKER)
      ) {
        files.set(relativePath, await readFile(path, "utf8"));
      }
    }
  };
  await visit(rootDir, "");
  return files;
}

function createCompilerViewKey(input: {
  readonly sourceSnapshotHash: string;
  readonly sourceProjectFingerprint: string;
  readonly sourceCompilerVersion: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceSnapshotHash: input.sourceSnapshotHash,
        sourceProjectFingerprint: input.sourceProjectFingerprint,
        sourceCompilerVersion: input.sourceCompilerVersion,
        targetCompilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
        migrationChainVersion: PRAGMA_COMPILER_MIGRATION_CHAIN_VERSION,
      }),
    )
    .digest("hex");
}

function compilerViewLocation(
  source: LocalHostProjectRevisionLocation,
  target: string,
  metadata: CompilerViewMetadata,
): LocalHostProjectRevisionLocation {
  return {
    ...source,
    rootDir: target,
    entryFile: join(target, "pragma.yaml"),
    compilerVersion: metadata.targetCompilerVersion,
    compilerViewKey: metadata.cacheKey,
    derivedProjectFingerprint: metadata.derivedProjectFingerprint,
  };
}

function isCompilerViewLocation(location: PragmaProjectRevisionLocation): boolean {
  return "compilerViewKey" in location && typeof location.compilerViewKey === "string";
}

async function readCompilerViewMetadata(path: string): Promise<CompilerViewMetadata | undefined> {
  try {
    return CompilerViewMetadataSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isNotFound(error) || error instanceof z.ZodError || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isMatchingCompilerView(
  metadata: CompilerViewMetadata | undefined,
  expected: Omit<CompilerViewMetadata, "derivedProjectFingerprint">,
): metadata is CompilerViewMetadata {
  if (metadata === undefined) return false;
  return (
    metadata.format === expected.format &&
    metadata.cacheKey === expected.cacheKey &&
    metadata.sourceSnapshotHash === expected.sourceSnapshotHash &&
    metadata.sourceProjectFingerprint === expected.sourceProjectFingerprint &&
    metadata.sourceCompilerVersion === expected.sourceCompilerVersion &&
    metadata.targetCompilerVersion === expected.targetCompilerVersion &&
    metadata.migrationChainVersion === expected.migrationChainVersion
  );
}

async function publishCompilerView(input: {
  readonly target: string;
  readonly cacheKey: string;
  readonly files: ReadonlyMap<string, string>;
  readonly metadata: CompilerViewMetadata;
}): Promise<void> {
  const temporary = join(dirname(input.target), `.compiler-${input.cacheKey}.tmp`);
  const retired = `${input.target}.retired`;
  await rm(temporary, { recursive: true, force: true });
  await rm(retired, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const [relativePath, contents] of input.files) {
      assertProjectRelativePath(relativePath);
      const path = join(temporary, relativePath);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, contents, { mode: 0o600 });
    }
    await writeFile(join(temporary, COMPILER_VIEW_MARKER), `${JSON.stringify(input.metadata)}\n`, {
      mode: 0o600,
    });
    await mkdir(dirname(input.target), { recursive: true, mode: 0o700 });
    let retiredExisting = false;
    try {
      await rename(input.target, retired);
      retiredExisting = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      await rename(temporary, input.target);
    } catch (error) {
      if (retiredExisting) {
        await rename(retired, input.target).catch(() => undefined);
      }
      throw error;
    }
    if (retiredExisting) await rm(retired, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertProjectRelativePath(path: string): void {
  const root = resolve("/pragma-local-host-project");
  const target = resolve(root, path);
  const child = relative(root, target);
  if (path.trim() === "" || isAbsolute(path) || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Project file path escapes its root: ${path}`);
  }
  if (path === ".pragma-snapshot" || path === COMPILER_VIEW_MARKER) {
    throw new Error(`Project file path is reserved for compiler view metadata: ${path}`);
  }
}

function unsupportedCompilerVersion(version: string): PragmaCompilerMigrationError {
  const match = /^pragma\.dsl\/v(\d+)$/u.exec(version);
  const number = match === null ? undefined : Number(match[1]);
  const targetMatch = /^pragma\.dsl\/v(\d+)$/u.exec(PRAGMA_COMPILER_WRITE_VERSION);
  const target = targetMatch === null ? Number.NaN : Number(targetMatch[1]);
  return new PragmaCompilerMigrationError(
    number !== undefined && number > target ? "future_compiler_version" : "missing_migration_step",
    `Pragma compiler ${version} cannot be upgraded to ${PRAGMA_COMPILER_WRITE_VERSION}.`,
  );
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
