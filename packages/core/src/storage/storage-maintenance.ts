import { readFile, readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { ContentAddressedStore, type ContentObjectRef } from "./content-addressed-store.ts";
import { purgeExpiredTrash } from "./deletion-transaction.ts";
import { withFileLock } from "./file-lock.ts";
import { PragmaPaths } from "./pragma-paths.ts";
import { DEFAULT_STORAGE_POLICY, type StoragePolicy } from "./storage-policy.ts";
import { rebuildStorageCatalog } from "./storage-catalog.ts";

export interface StorageOverview {
  readonly totalBytes: number;
  readonly dataBytes: number;
  readonly stateBytes: number;
  readonly archiveBytes: number;
  readonly cacheBytes: number;
  readonly temporaryBytes: number;
  readonly trashBytes: number;
  readonly softLimitBytes: number;
  readonly hardLimitBytes: number;
}

export interface StorageMaintenanceResult {
  readonly before: StorageOverview;
  readonly after: StorageOverview;
  readonly deletedCacheEntries: number;
  readonly deletedArchives: number;
  readonly deletedTemporaryEntries: number;
  readonly deletedTrashEntries: number;
  readonly deletedContentObjects: number;
  readonly reclaimedContentBytes: number;
}

export class StorageCapacityExceededError extends Error {
  constructor(readonly overview: StorageOverview) {
    super(
      `Pragma storage uses ${overview.totalBytes} bytes, above the hard limit of ${overview.hardLimitBytes} bytes. Delete or export persistent owners before creating more data.`,
    );
    this.name = "StorageCapacityExceededError";
  }
}

export async function inspectStorage(
  paths: PragmaPaths,
  policy: StoragePolicy = DEFAULT_STORAGE_POLICY,
): Promise<StorageOverview> {
  const seenInodes = new Set<string>();
  const dataBytes = await directoryBytes(paths.dataRoot(), seenInodes);
  const stateBytes = await directoryBytes(paths.stateRoot(), seenInodes);
  const archiveBytes = await directoryBytes(paths.archivesRoot(), seenInodes);
  const cacheBytes = await directoryBytes(paths.cacheRoot(), seenInodes);
  const temporaryBytes = await directoryBytes(paths.temporaryRoot(), seenInodes);
  const trashBytes = await directoryBytes(paths.trashRoot(), seenInodes);
  return {
    totalBytes: dataBytes + stateBytes + archiveBytes + cacheBytes + temporaryBytes + trashBytes,
    dataBytes,
    stateBytes,
    archiveBytes,
    cacheBytes,
    temporaryBytes,
    trashBytes,
    softLimitBytes: policy.globalSoftLimitBytes,
    hardLimitBytes: policy.globalHardLimitBytes,
  };
}

export async function assertStorageWriteAllowed(
  paths: PragmaPaths,
  policy: StoragePolicy = DEFAULT_STORAGE_POLICY,
): Promise<void> {
  const overview = await inspectStorage(paths, policy);
  if (overview.totalBytes < policy.globalHardLimitBytes) return;
  const maintenance = await runStorageMaintenance({ paths, policy, pressure: true });
  if (maintenance.after.totalBytes >= policy.globalHardLimitBytes) {
    throw new StorageCapacityExceededError(maintenance.after);
  }
}

export async function runStorageMaintenance(input: {
  readonly paths: PragmaPaths;
  readonly policy?: StoragePolicy | undefined;
  readonly now?: number | undefined;
  readonly pressure?: boolean | undefined;
}): Promise<StorageMaintenanceResult> {
  const policy = input.policy ?? DEFAULT_STORAGE_POLICY;
  const now = input.now ?? Date.now();
  return await withFileLock(input.paths.storageGcLock(), async () => {
    const before = await inspectStorage(input.paths, policy);
    const cacheCandidates = await collectCacheCandidates(input.paths);
    const cache = await pruneCandidates(cacheCandidates, {
      ttlMs: policy.cacheTtlMs,
      limitBytes: policy.cacheLimitBytes,
      now,
    });
    const archives = await pruneCandidates(
      await directChildren(input.paths.executionArchivesRoot()),
      {
        ttlMs: policy.executionArchiveTtlMs,
        limitBytes: policy.executionArchiveLimitBytes,
        now,
      },
    );
    const temporary = await pruneCandidates(await directChildren(input.paths.temporaryRoot()), {
      ttlMs: policy.temporaryTtlMs,
      limitBytes: 0,
      now,
      ttlOnly: true,
    });
    const trash = await purgeExpiredTrash({ paths: input.paths, ttlMs: policy.trashTtlMs, now });
    const roots = await readProjectSnapshotRoots(input.paths);
    const content = await new ContentAddressedStore(
      input.paths.contentObjectsRoot(),
    ).collectGarbage({
      roots,
      graceMs: policy.contentGcGraceMs,
      now,
    });
    const afterRebuildableCleanup = await inspectStorage(input.paths, policy);
    const pressureTrash =
      input.pressure === true && afterRebuildableCleanup.totalBytes > policy.globalSoftLimitBytes
        ? await purgeCompletedTrashForPressure(
            input.paths,
            afterRebuildableCleanup.totalBytes - policy.globalSoftLimitBytes,
          )
        : { deleted: 0 };
    const after = await inspectStorage(input.paths, policy);
    await rebuildStorageCatalog(input.paths, new Date(now));
    return {
      before,
      after,
      deletedCacheEntries: cache.deleted,
      deletedArchives: archives.deleted,
      deletedTemporaryEntries: temporary.deleted,
      deletedTrashEntries: trash.deleted + pressureTrash.deleted,
      deletedContentObjects: content.deletedObjects,
      reclaimedContentBytes: content.reclaimedBytes,
    };
  });
}

async function purgeCompletedTrashForPressure(
  paths: PragmaPaths,
  reclaimBytes: number,
): Promise<{ readonly deleted: number }> {
  const candidates = await directChildren(paths.trashRoot());
  const completed = (
    await Promise.all(
      candidates.map(async (candidate) => {
        const deletionId = basename(candidate.path);
        const journalPath = join(paths.deletionJournalRoot(), `${deletionId}.json`);
        const journal = await readFile(journalPath, "utf8")
          .then(
            (value) =>
              JSON.parse(value) as {
                readonly status?: unknown;
                readonly completedAt?: unknown;
              },
          )
          .catch(() => undefined);
        if (journal?.status !== "trashed" || typeof journal.completedAt !== "string") {
          return undefined;
        }
        const completedAt = Date.parse(journal.completedAt);
        return Number.isFinite(completedAt)
          ? { ...candidate, journalPath, completedAt }
          : undefined;
      }),
    )
  )
    .filter((candidate) => candidate !== undefined)
    .toSorted((left, right) => left.completedAt - right.completedAt);
  let reclaimed = 0;
  let deleted = 0;
  for (const candidate of completed) {
    if (reclaimed >= reclaimBytes) break;
    await rm(candidate.path, { recursive: true, force: true });
    await rm(candidate.journalPath, { force: true });
    reclaimed += candidate.bytes;
    deleted += 1;
  }
  return { deleted };
}

interface Candidate {
  readonly path: string;
  readonly bytes: number;
  readonly accessedAt: number;
}

async function collectCacheCandidates(paths: PragmaPaths): Promise<Candidate[]> {
  return [
    ...(await hashDirectoryCandidates(paths.pluginPackagesCacheRoot())),
    ...(await directChildren(join(paths.codexRuntimeCacheRoot(), "bases"))),
    ...(await hashDirectoryCandidates(join(paths.codexRuntimeCacheRoot(), "skills"))),
    ...(await unleasedProjectViewCandidates(paths)),
    ...(await directChildren(paths.agentsCacheRoot())),
  ];
}

async function unleasedProjectViewCandidates(paths: PragmaPaths): Promise<Candidate[]> {
  const candidates = await directChildren(paths.projectViewsCacheRoot());
  const leasesRoot = join(paths.cacheRoot(), "project-view-leases");
  const leasedSnapshots = new Set<string>();
  for (const leaseDirectory of await directChildren(leasesRoot)) {
    if ((await stat(leaseDirectory.path).catch(() => undefined))?.isDirectory() !== true) continue;
    const leases = await directChildren(leaseDirectory.path);
    let leased = false;
    for (const lease of leases) {
      let pid: unknown;
      try {
        pid = (JSON.parse(await readFile(lease.path, "utf8")) as { readonly pid?: unknown }).pid;
      } catch {
        pid = undefined;
      }
      if (typeof pid === "number" && isProcessAlive(pid)) {
        leased = true;
        continue;
      }
      await rm(lease.path, { force: true });
    }
    if (leased) leasedSnapshots.add(basename(leaseDirectory.path));
    else await removeEmptyDirectory(leaseDirectory.path);
  }
  return candidates.filter((candidate) => !leasedSnapshots.has(basename(candidate.path)));
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

async function hashDirectoryCandidates(root: string): Promise<Candidate[]> {
  const output: Candidate[] = [];
  for (const prefix of await directChildren(root)) {
    if ((await stat(prefix.path).catch(() => undefined))?.isDirectory() !== true) continue;
    output.push(...(await directChildren(prefix.path)));
  }
  return output;
}

async function directChildren(root: string): Promise<Candidate[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  return await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = join(root, entry.name);
        const metadata = await stat(path);
        return {
          path,
          bytes: entry.isDirectory() ? await directoryBytes(path) : metadata.size,
          accessedAt: Math.max(metadata.atimeMs, metadata.mtimeMs),
        };
      }),
  );
}

async function pruneCandidates(
  candidates: readonly Candidate[],
  input: {
    readonly ttlMs: number;
    readonly limitBytes: number;
    readonly now: number;
    readonly ttlOnly?: boolean | undefined;
  },
): Promise<{ readonly deleted: number }> {
  const ordered = [...candidates].toSorted((left, right) => left.accessedAt - right.accessedAt);
  let bytes = ordered.reduce((total, candidate) => total + candidate.bytes, 0);
  let deleted = 0;
  for (const candidate of ordered) {
    const expired = input.now - candidate.accessedAt >= input.ttlMs;
    const pressured = input.ttlOnly !== true && bytes > input.limitBytes;
    if (!expired && !pressured) continue;
    await rm(candidate.path, { recursive: true, force: true });
    bytes -= candidate.bytes;
    deleted += 1;
  }
  return { deleted };
}

async function readProjectSnapshotRoots(
  paths: PragmaPaths,
): Promise<readonly (ContentObjectRef & { readonly kind: "tree" })[]> {
  const roots: (ContentObjectRef & { readonly kind: "tree" })[] = [];
  for (const project of await childDirectories(paths.projectsRoot())) {
    const revisions = join(project, "revisions");
    let files;
    try {
      files = await readdir(revisions, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const value = JSON.parse(await readFile(join(revisions, file.name), "utf8")) as {
        readonly snapshotHash?: unknown;
      };
      if (typeof value.snapshotHash === "string" && /^[a-f0-9]{64}$/.test(value.snapshotHash)) {
        roots.push({ kind: "tree", hash: value.snapshotHash });
      }
    }
  }
  return roots;
}

async function childDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function directoryBytes(root: string, seenInodes?: Set<string>): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) bytes += await directoryBytes(path, seenInodes);
    else if (entry.isFile()) {
      const metadata = await stat(path);
      const inode = `${metadata.dev}:${metadata.ino}`;
      if (seenInodes?.has(inode) === true) continue;
      seenInodes?.add(inode);
      bytes += metadata.size;
    }
  }
  return bytes;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
