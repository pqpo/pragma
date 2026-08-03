import { readFile, readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { ContentAddressedStore, type ContentObjectRef } from "./content-addressed-store.ts";
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

export interface TrashMaintenanceResult {
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly deletedEntries: number;
  readonly reclaimedBytes: number;
}

export interface StorageCapacityGuard {
  assertWriteAllowed(): Promise<void>;
  refresh(): Promise<StorageOverview>;
  current(): StorageOverview | undefined;
  close(): void;
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

export function createStorageCapacityGuard(input: {
  readonly paths: PragmaPaths;
  readonly policy?: StoragePolicy | undefined;
  readonly initialOverview?: StorageOverview | undefined;
  readonly refreshIntervalMs?: number | undefined;
  readonly maxSnapshotAgeMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}): StorageCapacityGuard {
  const policy = input.policy ?? DEFAULT_STORAGE_POLICY;
  const refreshIntervalMs = input.refreshIntervalMs ?? 30_000;
  const maxSnapshotAgeMs =
    input.maxSnapshotAgeMs ??
    (refreshIntervalMs > 0 ? refreshIntervalMs * 2 : Number.POSITIVE_INFINITY);
  const now = input.now ?? Date.now;
  let overview = input.initialOverview;
  let inspectedAt = overview === undefined ? 0 : now();
  let refreshing: Promise<StorageOverview> | undefined;
  let closed = false;

  const refresh = async (): Promise<StorageOverview> => {
    if (refreshing !== undefined) return await refreshing;
    const operation = inspectStorage(input.paths, policy).then((next) => {
      overview = next;
      inspectedAt = now();
      return next;
    });
    refreshing = operation;
    try {
      return await operation;
    } finally {
      if (refreshing === operation) refreshing = undefined;
    }
  };

  const interval =
    refreshIntervalMs <= 0
      ? undefined
      : setInterval(() => {
          if (!closed) void refresh().catch(() => undefined);
        }, refreshIntervalMs);
  interval?.unref();

  return {
    async assertWriteAllowed() {
      let current = overview;
      const age = now() - inspectedAt;
      if (
        current === undefined ||
        current.totalBytes >= policy.globalSoftLimitBytes ||
        age >= maxSnapshotAgeMs
      ) {
        current = await refresh();
      } else if (refreshIntervalMs > 0 && age >= refreshIntervalMs) {
        void refresh().catch(() => undefined);
      }
      if (current.totalBytes < policy.globalHardLimitBytes) return;
      const maintenance = await runStorageMaintenance({
        paths: input.paths,
        policy,
        pressure: true,
      });
      overview = maintenance.after;
      inspectedAt = now();
      if (maintenance.after.totalBytes >= policy.globalHardLimitBytes) {
        throw new StorageCapacityExceededError(maintenance.after);
      }
    },
    refresh,
    current: () => overview,
    close() {
      closed = true;
      if (interval !== undefined) clearInterval(interval);
    },
  };
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
    const trash = await pruneCompletedTrash({ paths: input.paths, policy, now });
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

export async function runTrashMaintenance(input: {
  readonly paths: PragmaPaths;
  readonly policy?: StoragePolicy | undefined;
  readonly now?: number | undefined;
}): Promise<TrashMaintenanceResult> {
  const policy = input.policy ?? DEFAULT_STORAGE_POLICY;
  const now = input.now ?? Date.now();
  return await withFileLock(input.paths.storageGcLock(), async () => {
    const beforeBytes = await directoryBytes(input.paths.trashRoot());
    const result = await pruneCompletedTrash({ paths: input.paths, policy, now });
    const afterBytes = await directoryBytes(input.paths.trashRoot());
    return {
      beforeBytes,
      afterBytes,
      deletedEntries: result.deleted,
      reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
    };
  });
}

async function pruneCompletedTrash(input: {
  readonly paths: PragmaPaths;
  readonly policy: StoragePolicy;
  readonly now: number;
}): Promise<{ readonly deleted: number }> {
  const candidates = await completedTrashCandidates(input.paths);
  let bytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  let entries = candidates.length;
  let deleted = 0;
  for (const candidate of candidates) {
    const expired = input.now - candidate.completedAt >= input.policy.trashTtlMs;
    const overLimit =
      bytes > input.policy.trashLimitBytes || entries > input.policy.trashMaxEntries;
    if (!expired && !overLimit) continue;
    await deleteTrashCandidate(candidate);
    bytes -= candidate.bytes;
    entries -= 1;
    deleted += 1;
  }
  return { deleted };
}

async function purgeCompletedTrashForPressure(
  paths: PragmaPaths,
  reclaimBytes: number,
): Promise<{ readonly deleted: number }> {
  const completed = await completedTrashCandidates(paths);
  let reclaimed = 0;
  let deleted = 0;
  for (const candidate of completed) {
    if (reclaimed >= reclaimBytes) break;
    await deleteTrashCandidate(candidate);
    reclaimed += candidate.bytes;
    deleted += 1;
  }
  return { deleted };
}

interface CompletedTrashCandidate extends Candidate {
  readonly deletionId: string;
  readonly journalPath: string;
  readonly completedAt: number;
}

async function completedTrashCandidates(paths: PragmaPaths): Promise<CompletedTrashCandidate[]> {
  const candidates = await directChildren(paths.trashRoot());
  return (
    await Promise.all(
      candidates.map(async (candidate) => {
        const deletionId = basename(candidate.path);
        const journalPath = join(paths.deletionJournalRoot(), `${deletionId}.json`);
        const journal = await readFile(journalPath, "utf8")
          .then(
            (value) =>
              JSON.parse(value) as {
                readonly schemaVersion?: unknown;
                readonly deletionId?: unknown;
                readonly status?: unknown;
                readonly completedAt?: unknown;
              },
          )
          .catch(() => undefined);
        if (
          journal?.schemaVersion !== "pragma.storage-deletion/v1" ||
          journal.deletionId !== deletionId ||
          journal.status !== "trashed" ||
          typeof journal.completedAt !== "string"
        ) {
          return undefined;
        }
        const completedAt = Date.parse(journal.completedAt);
        return Number.isFinite(completedAt)
          ? { ...candidate, deletionId, journalPath, completedAt }
          : undefined;
      }),
    )
  )
    .filter((candidate) => candidate !== undefined)
    .toSorted(
      (left, right) =>
        left.completedAt - right.completedAt || left.deletionId.localeCompare(right.deletionId),
    );
}

async function deleteTrashCandidate(candidate: CompletedTrashCandidate): Promise<void> {
  await rm(candidate.path, { recursive: true, force: true });
  await rm(candidate.journalPath, { force: true });
}

interface Candidate {
  readonly path: string;
  readonly bytes: number;
  readonly accessedAt: number;
}

async function collectCacheCandidates(paths: PragmaPaths): Promise<Candidate[]> {
  return [
    ...(await hashDirectoryCandidates(paths.compilerBlueprintsCacheRoot())),
    ...(await hashDirectoryCandidates(paths.pluginPackagesCacheRoot())),
    ...(await unleasedCodexBaseCandidates(paths)),
    ...(await hashDirectoryCandidates(join(paths.codexRuntimeCacheRoot(), "skills"))),
    ...(await unleasedProjectViewCandidates(paths)),
    ...(await directChildren(paths.agentsCacheRoot())),
  ];
}

async function unleasedCodexBaseCandidates(paths: PragmaPaths): Promise<Candidate[]> {
  const candidates = (await directChildren(join(paths.codexRuntimeCacheRoot(), "bases"))).filter(
    (candidate) => /^[a-f0-9]{64}$/.test(basename(candidate.path)),
  );
  const leasesRoot = join(paths.codexRuntimeCacheRoot(), "base-leases");
  const leasedFingerprints = new Set<string>();
  for (const leaseDirectory of await directChildren(leasesRoot)) {
    const fingerprint = basename(leaseDirectory.path);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) continue;
    if ((await stat(leaseDirectory.path).catch(() => undefined))?.isDirectory() !== true) continue;
    let leased = false;
    for (const lease of await directChildren(leaseDirectory.path)) {
      let pid: unknown;
      try {
        pid = (JSON.parse(await readFile(lease.path, "utf8")) as { readonly pid?: unknown }).pid;
      } catch {
        pid = undefined;
      }
      if (typeof pid === "number" && isProcessAlive(pid)) {
        leased = true;
      } else {
        await rm(lease.path, { force: true });
      }
    }
    if (leased) leasedFingerprints.add(fingerprint);
    else await removeEmptyDirectory(leaseDirectory.path);
  }
  return candidates.filter((candidate) => !leasedFingerprints.has(basename(candidate.path)));
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
