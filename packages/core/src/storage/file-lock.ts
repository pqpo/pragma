import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface LocalLockWaiter {
  cancelled: boolean;
  readonly operation?: string | undefined;
  timeout?: ReturnType<typeof setTimeout> | undefined;
  readonly grant: () => void;
}

interface LocalLockState {
  acquiredAt: number;
  operation?: string | undefined;
  readonly waiters: LocalLockWaiter[];
}

interface FileLockOwner {
  readonly version: 1;
  readonly ownerToken: string;
  readonly processId: number;
  readonly processStartedAt: number;
  readonly acquiredAt: number;
  readonly operation?: string | undefined;
}

export interface FileLockOptions {
  readonly timeoutMs?: number | undefined;
  readonly staleMs?: number | undefined;
  readonly operation?: string | undefined;
  /** Test-only hook for deterministic lock lifecycle crash coverage. */
  readonly onPhase?: ((phase: FileLockPhase) => Promise<void> | void) | undefined;
}

export type FileLockPhase =
  | "staging-created"
  | "staged"
  | "published"
  | "release-before-retire"
  | "release-after-retire"
  | "reclaim-before-retire"
  | "reclaim-after-retire"
  | "retired-cleanup";

export class FileLockTimeoutError extends Error {
  readonly code = "pragma_file_lock_timeout";
  readonly lockDir: string;
  readonly contention: "local" | "active" | "possibly-orphaned";
  readonly heldMs?: number | undefined;
  readonly operation?: string | undefined;

  constructor(
    message: string,
    lockDir: string,
    contention: "local" | "active" | "possibly-orphaned",
    heldMs?: number | undefined,
    operation?: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileLockTimeoutError";
    this.lockDir = lockDir;
    this.contention = contention;
    this.heldMs = heldMs;
    this.operation = operation;
  }
}

type LockContention =
  | { readonly kind: "active"; readonly owner: FileLockOwner }
  | {
      readonly kind: "possibly-orphaned";
      readonly reason:
        "missing-owner-metadata" | "owner-process-exited" | "owner-status-unavailable";
    };

type LockGeneration =
  | { readonly ownerToken: string }
  | { readonly ownerToken?: undefined; readonly device: number; readonly inode: number };

const OWNER_FILE_NAME = "owner.json";
const RECLAIM_DIRECTORY_NAME = ".reclaim";
const STAGING_DIRECTORY_MARKER = ".staging-";
const RETIRED_DIRECTORY_MARKERS = [".retired-", ".reclaim-"] as const;
const CURRENT_PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1_000);
const localLocks = new Map<string, LocalLockState>();

export async function withFileLock<TValue>(
  lockDir: string,
  operation: () => Promise<TValue>,
  options: FileLockOptions = {},
): Promise<TValue> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const startedAt = Date.now();
  const releaseLocalLock = await acquireLocalLock(lockDir, startedAt, timeoutMs, options.operation);
  try {
    return await withCrossProcessFileLock(lockDir, operation, options, startedAt);
  } finally {
    releaseLocalLock();
  }
}

async function withCrossProcessFileLock<TValue>(
  lockDir: string,
  operation: () => Promise<TValue>,
  options: FileLockOptions,
  startedAt: number,
): Promise<TValue> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  await retryTransientFsOperation(
    () => mkdir(dirname(lockDir), { recursive: true }).then(() => undefined),
    startedAt,
    timeoutMs,
    `creating the Pragma lock parent: ${lockDir}`,
  );

  await reclaimRetiredDirectories(lockDir);
  await reclaimStagingDirectories(lockDir, staleMs);
  while (true) {
    try {
      await stat(lockDir);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await publishLock(lockDir, options);
        break;
      } catch (publishError) {
        if (!isRetryableLockContention(publishError)) throw publishError;
        await reclaimStagingDirectories(lockDir, staleMs);
      }
    }
    const assessment = await assessLock(lockDir, staleMs);
    if (
      assessment.reclaimGeneration !== undefined &&
      (await reclaimLock(lockDir, assessment.reclaimGeneration, options))
    ) {
      continue;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw lockTimeout(lockDir, assessment.contention, new Error("lock contention"));
    }
    await delay(10);
  }

  const ownerPath = join(lockDir, OWNER_FILE_NAME);
  let ownerFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    ownerFile = await open(ownerPath, "r+");
  } catch (error) {
    await retireUnusableLock(lockDir, timeoutMs);
    throw error;
  }
  if (ownerFile === undefined) throw new Error(`Failed to initialize Pragma file lock: ${lockDir}`);

  const owner = await readLockOwner(ownerPath);
  if (owner === undefined) {
    await ownerFile.close().catch(() => undefined);
    await retireUnusableLock(lockDir, timeoutMs);
    throw new Error(`Failed to validate Pragma file lock owner: ${lockDir}`);
  }

  const refreshIntervalMs = Math.max(10, Math.min(1_000, Math.floor(staleMs / 3)));
  const leaseTimer = setInterval(() => {
    const now = new Date();
    void ownerFile.utimes(now, now).catch(() => undefined);
  }, refreshIntervalMs);
  leaseTimer.unref();

  try {
    return await operation();
  } finally {
    clearInterval(leaseTimer);
    try {
      await ownerFile.close();
    } finally {
      if ((await readLockOwner(ownerPath))?.ownerToken === owner.ownerToken) {
        const retiredDir = await retireLock(
          lockDir,
          { ownerToken: owner.ownerToken },
          "release",
          options.onPhase,
          timeoutMs,
        );
        if (retiredDir !== undefined) {
          await cleanupRetiredDirectory(retiredDir, options.onPhase);
        }
      }
    }
  }
}

async function publishLock(lockDir: string, options: FileLockOptions): Promise<void> {
  const owner: FileLockOwner = {
    version: 1,
    ownerToken: randomUUID(),
    processId: process.pid,
    processStartedAt: CURRENT_PROCESS_STARTED_AT,
    acquiredAt: Date.now(),
    ...(options.operation === undefined ? {} : { operation: options.operation }),
  };
  const stagingDir = `${lockDir}${STAGING_DIRECTORY_MARKER}${owner.ownerToken}`;
  const stagingOwnerPath = join(stagingDir, OWNER_FILE_NAME);
  let ownerFile: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    await mkdir(stagingDir, { mode: 0o700 });
    await options.onPhase?.("staging-created");
    ownerFile = await open(stagingOwnerPath, "wx", 0o600);
    await ownerFile.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await ownerFile.sync();
    await ownerFile.close();
    ownerFile = undefined;
    await options.onPhase?.("staged");

    try {
      await stat(lockDir);
      throw lockTargetAppeared(lockDir);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await rename(stagingDir, lockDir);
    published = true;
    await options.onPhase?.("published");
  } catch (error) {
    await ownerFile?.close().catch(() => undefined);
    if (published) {
      await retireLock(
        lockDir,
        { ownerToken: owner.ownerToken },
        "reclaim",
        undefined,
        options.timeoutMs ?? 10_000,
      )
        .then(async (retiredDir) => {
          if (retiredDir !== undefined) await cleanupRetiredDirectory(retiredDir);
        })
        .catch(() => undefined);
    } else {
      await rm(stagingDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function reclaimStagingDirectories(lockDir: string, staleMs: number): Promise<void> {
  const parent = dirname(lockDir);
  const prefix = `${basename(lockDir)}${STAGING_DIRECTORY_MARKER}`;
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const stagingDir = join(parent, entry);
        const owner = await readLockOwner(join(stagingDir, OWNER_FILE_NAME));
        if (owner !== undefined && processStatus(owner) !== "dead") return;
        if (owner === undefined && (await pathStaleness(stagingDir, staleMs)) !== "stale") return;
        await rm(stagingDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      }),
  );
}

async function reclaimRetiredDirectories(lockDir: string): Promise<void> {
  const parent = dirname(lockDir);
  const prefix = basename(lockDir);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) =>
        RETIRED_DIRECTORY_MARKERS.some((marker) => entry.startsWith(`${prefix}${marker}`)),
      )
      .map(async (entry) => {
        await cleanupRetiredDirectory(join(parent, entry));
      }),
  );
}

async function cleanupRetiredDirectory(
  retiredDir: string,
  onPhase?: FileLockOptions["onPhase"],
): Promise<void> {
  await onPhase?.("retired-cleanup");
  try {
    await rm(retiredDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  } catch (error) {
    // A retired directory is already outside the lock name. Leave it for the
    // next bounded, directed cleanup pass if the platform temporarily keeps
    // a handle open; never recreate the final lock name from this path.
    if (isNotFound(error) || isRetryableLockContention(error)) return;
    throw error;
  }
}

async function retireUnusableLock(lockDir: string, timeoutMs: number): Promise<void> {
  const generation = await readDirectoryGeneration(lockDir);
  if (generation === undefined) return;
  const retiredDir = await retireLock(lockDir, generation, "reclaim", undefined, timeoutMs);
  if (retiredDir !== undefined) await cleanupRetiredDirectory(retiredDir);
}

async function retireLock(
  lockDir: string,
  expected: LockGeneration,
  kind: "release" | "reclaim",
  options: FileLockOptions["onPhase"] | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  if (!(await lockGenerationMatches(lockDir, expected))) return undefined;

  if (kind === "release") await options?.("release-before-retire");
  const retiredDir = `${lockDir}${kind === "release" ? ".retired-" : ".reclaim-"}${retirementIdentity(expected)}-${randomUUID()}`;
  try {
    await retryTransientFsOperation(
      () => rename(lockDir, retiredDir),
      Date.now(),
      timeoutMs,
      `retiring the Pragma file lock: ${lockDir}`,
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (kind === "release") await options?.("release-after-retire");
  return retiredDir;
}

function retirementIdentity(expected: LockGeneration): string {
  return expected.ownerToken ?? `${expected.device}-${expected.inode}`;
}

function lockTargetAppeared(lockDir: string): Error & { readonly code: "EEXIST" } {
  const error = new Error(`Pragma file lock appeared while publishing: ${lockDir}`) as Error & {
    readonly code: "EEXIST";
  };
  Object.defineProperty(error, "code", { value: "EEXIST", enumerable: true });
  return error;
}

async function acquireLocalLock(
  lockDir: string,
  startedAt: number,
  timeoutMs: number,
  operation: string | undefined,
): Promise<() => void> {
  const state = localLocks.get(lockDir);
  if (state === undefined) {
    localLocks.set(lockDir, { acquiredAt: Date.now(), operation, waiters: [] });
  } else {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw localLockTimeout(lockDir, state);
    await new Promise<void>((resolve, reject) => {
      const waiter: LocalLockWaiter = {
        cancelled: false,
        operation,
        grant: () => {
          if (waiter.cancelled) return;
          if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
          state.acquiredAt = Date.now();
          state.operation = waiter.operation;
          resolve();
        },
      };
      state.waiters.push(waiter);
      waiter.timeout = setTimeout(() => {
        waiter.cancelled = true;
        reject(localLockTimeout(lockDir, state));
      }, remainingMs);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = localLocks.get(lockDir);
    while (true) {
      const next = current?.waiters.shift();
      if (next === undefined) {
        localLocks.delete(lockDir);
        return;
      }
      if (!next.cancelled) {
        next.grant();
        return;
      }
    }
  };
}

function localLockTimeout(lockDir: string, state: LocalLockState): FileLockTimeoutError {
  const heldMs = Math.max(0, Date.now() - state.acquiredAt);
  const operation = state.operation;
  return new FileLockTimeoutError(
    `Timed out waiting for Pragma in-process file lock: ${lockDir} (held ${heldMs}ms${operation === undefined ? "" : ` by ${operation}`})`,
    lockDir,
    "local",
    heldMs,
    operation,
  );
}

async function assessLock(
  lockDir: string,
  staleMs: number,
): Promise<{
  readonly reclaimGeneration?: LockGeneration | undefined;
  readonly contention: LockContention;
}> {
  const ownerPath = join(lockDir, OWNER_FILE_NAME);
  const owner = await readLockOwner(ownerPath);
  if (owner !== undefined) {
    const status = processStatus(owner);
    if (status === "dead") {
      return {
        reclaimGeneration: { ownerToken: owner.ownerToken },
        contention: { kind: "possibly-orphaned", reason: "owner-process-exited" },
      };
    }
    if (status === "alive") {
      return { contention: { kind: "active", owner } };
    }
    return {
      reclaimGeneration: (await isStalePath(ownerPath, staleMs))
        ? { ownerToken: owner.ownerToken }
        : undefined,
      contention: { kind: "possibly-orphaned", reason: "owner-status-unavailable" },
    };
  }
  const generation = await readDirectoryGeneration(lockDir);
  const ownerLease = await pathStaleness(ownerPath, staleMs);
  const reclaim =
    ownerLease === "stale" ||
    (ownerLease === "missing" && (await pathStaleness(lockDir, staleMs)) === "stale");
  return {
    reclaimGeneration: generation !== undefined && reclaim ? generation : undefined,
    contention: { kind: "possibly-orphaned", reason: "missing-owner-metadata" },
  };
}

async function reclaimLock(
  lockDir: string,
  expected: LockGeneration,
  options: FileLockOptions,
): Promise<boolean> {
  await options.onPhase?.("reclaim-before-retire");
  if (!(await claimReclaimMarker(lockDir, staleMsFor(options)))) return false;

  if (!(await lockGenerationMatches(lockDir, expected))) {
    await removeReclaimMarker(lockDir);
    return false;
  }

  const retiredDir = `${lockDir}.reclaim-${retirementIdentity(expected)}-${randomUUID()}`;
  try {
    await retryTransientFsOperation(
      () => rename(lockDir, retiredDir),
      Date.now(),
      options.timeoutMs ?? 10_000,
      `reclaiming the Pragma file lock: ${lockDir}`,
    );
  } catch (error) {
    if (isNotFound(error)) {
      await removeReclaimMarker(lockDir);
      return false;
    }
    throw error;
  }

  await options.onPhase?.("reclaim-after-retire");
  await cleanupRetiredDirectory(retiredDir, options.onPhase);
  return true;
}

function staleMsFor(options: FileLockOptions): number {
  return options.staleMs ?? 30_000;
}

async function claimReclaimMarker(lockDir: string, staleMs: number): Promise<boolean> {
  const reclaimDir = join(lockDir, RECLAIM_DIRECTORY_NAME);
  try {
    await mkdir(reclaimDir, { mode: 0o700 });
  } catch (error) {
    if (isNotFound(error) || isRetryableLockContention(error)) {
      if (!isAlreadyExists(error)) return false;
      const marker = await readLockOwner(join(reclaimDir, OWNER_FILE_NAME));
      if (marker !== undefined && processStatus(marker) !== "dead") return false;
      if (marker === undefined && (await pathStaleness(reclaimDir, staleMs)) !== "stale") {
        return false;
      }
      await rm(reclaimDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      return false;
    }
    throw error;
  }

  const marker: FileLockOwner = {
    version: 1,
    ownerToken: randomUUID(),
    processId: process.pid,
    processStartedAt: CURRENT_PROCESS_STARTED_AT,
    acquiredAt: Date.now(),
    operation: "file-lock.reclaim",
  };
  const markerPath = join(reclaimDir, OWNER_FILE_NAME);
  let markerFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    markerFile = await open(markerPath, "wx", 0o600);
    await markerFile.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await markerFile.sync();
    await markerFile.close();
    return true;
  } catch (error) {
    await markerFile?.close().catch(() => undefined);
    await rm(reclaimDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }).catch(() => undefined);
    throw error;
  }
}

async function removeReclaimMarker(lockDir: string): Promise<void> {
  await rm(join(lockDir, RECLAIM_DIRECTORY_NAME), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  }).catch((error: unknown) => {
    if (isNotFound(error) || isRetryableLockContention(error)) return;
    throw error;
  });
}

async function lockGenerationMatches(lockDir: string, expected: LockGeneration): Promise<boolean> {
  const owner = await readLockOwner(join(lockDir, OWNER_FILE_NAME));
  if (expected.ownerToken !== undefined) return owner?.ownerToken === expected.ownerToken;
  if (owner !== undefined) return false;
  const current = await readDirectoryGeneration(lockDir);
  return current?.device === expected.device && current.inode === expected.inode;
}

async function readDirectoryGeneration(
  lockDir: string,
): Promise<{ readonly device: number; readonly inode: number } | undefined> {
  try {
    const metadata = await stat(lockDir);
    return { device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if (isNotFound(error) || isRetryableLockContention(error)) return undefined;
    throw error;
  }
}

async function readLockOwner(ownerPath: string): Promise<FileLockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Partial<FileLockOwner>;
    if (
      candidate.version !== 1 ||
      typeof candidate.ownerToken !== "string" ||
      candidate.ownerToken.length === 0 ||
      !Number.isSafeInteger(candidate.processId) ||
      (candidate.processId ?? 0) <= 0 ||
      typeof candidate.processStartedAt !== "number" ||
      !Number.isFinite(candidate.processStartedAt) ||
      typeof candidate.acquiredAt !== "number" ||
      !Number.isFinite(candidate.acquiredAt) ||
      (candidate.operation !== undefined && typeof candidate.operation !== "string")
    ) {
      return undefined;
    }
    return candidate as FileLockOwner;
  } catch (error) {
    if (error instanceof SyntaxError || isNotFound(error) || isRetryableLockContention(error)) {
      return undefined;
    }
    throw error;
  }
}

function processStatus(owner: FileLockOwner): "alive" | "dead" | "unknown" {
  if (owner.processId === process.pid) {
    return owner.processStartedAt === CURRENT_PROCESS_STARTED_AT ? "alive" : "dead";
  }
  try {
    process.kill(owner.processId, 0);
    return "alive";
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

async function isStalePath(path: string, staleMs: number): Promise<boolean> {
  return (await pathStaleness(path, staleMs)) === "stale";
}

async function pathStaleness(
  path: string,
  staleMs: number,
): Promise<"fresh" | "stale" | "missing" | "unknown"> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > staleMs ? "stale" : "fresh";
  } catch (error) {
    if (isNotFound(error)) return "missing";
    if (isRetryableLockContention(error)) return "unknown";
    throw error;
  }
}

function lockTimeout(
  lockDir: string,
  contention: LockContention,
  cause: unknown,
): FileLockTimeoutError {
  if (contention.kind === "active") {
    const heldMs = Math.max(0, Date.now() - contention.owner.acquiredAt);
    return new FileLockTimeoutError(
      `Timed out waiting for active Pragma file lock: ${lockDir} (owner PID ${contention.owner.processId}, held ${heldMs}ms${contention.owner.operation === undefined ? "" : ` by ${contention.owner.operation}`})`,
      lockDir,
      "active",
      heldMs,
      contention.owner.operation,
      { cause },
    );
  }
  const reason =
    contention.reason === "missing-owner-metadata"
      ? "owner metadata is missing or invalid"
      : contention.reason === "owner-process-exited"
        ? "owner process no longer exists"
        : "owner process status could not be confirmed";
  return new FileLockTimeoutError(
    `Timed out waiting for possibly orphaned Pragma file lock: ${lockDir} (${reason})`,
    lockDir,
    "possibly-orphaned",
    undefined,
    undefined,
    { cause },
  );
}

async function retryTransientFsOperation(
  operation: () => Promise<void>,
  startedAt: number,
  timeoutMs: number,
  description: string,
): Promise<void> {
  while (true) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isRetryableLockContention(error)) throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out ${description}`, { cause: error });
      }
      await delay(10);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyExists(error: unknown): boolean {
  return readErrorCode(error) === "EEXIST";
}

function isRetryableLockContention(error: unknown): boolean {
  const code = readErrorCode(error);
  return code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY";
}

function isNotFound(error: unknown): boolean {
  return readErrorCode(error) === "ENOENT";
}

function readErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
