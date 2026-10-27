import { ExpertSessionLeaseSchema } from "../execution/expert-session-lease.ts";
import { withFileLock } from "../storage/file-lock.ts";
import { runtimeHostProcessStatus } from "./host-process.ts";
import type { RuntimeHostProcess } from "../storage/migrations/runtime-session/index.ts";
import { stat, readFile } from "node:fs/promises";
import { isOwnerDeletionFenced } from "../storage/owner-deletion.ts";
import { type RuntimeSessionRecord } from "../storage/migrations/runtime-session/index.ts";
import {
  openRuntimeSessionCatalog,
  runtimeSessionCatalogPath,
  upgradeRuntimeSessionCatalogRecord,
} from "../storage/migrations/runtime-session-catalog/index.ts";
import type { PragmaPaths } from "../storage/pragma-paths.ts";
import type {
  RuntimeAdapterDescriptor,
  RuntimeContextWindowUsage,
  RuntimeSessionOwner,
  RuntimeSessionRef,
} from "./runtime-adapter.ts";

export type { RuntimeSessionRecord, RuntimeHostProcess };
export type RuntimeSessionProcessState = RuntimeSessionRecord["processState"];
export type RuntimeSessionRetentionState = RuntimeSessionRecord["retentionState"];

export async function createRuntimeSessionRecord(options: {
  readonly paths: PragmaPaths;
  readonly owner: RuntimeSessionOwner;
  readonly systemSessionId: string;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly workspace: string;
  readonly processOwner?: RuntimeHostProcess | null;
}): Promise<RuntimeSessionRecord> {
  if (isOwnerDeletionFenced(options.paths, options.owner.ownerId))
    throw new Error("RUNTIME_OWNER_DELETED");
  const now = new Date().toISOString();
  const record: RuntimeSessionRecord = {
    schemaVersion: "pragma.runtime-session/v4",
    owner: options.owner,
    systemSessionId: options.systemSessionId,
    expertId: options.agentId,
    runtime: { id: options.runtime.id, kind: options.runtime.kind },
    runtimeSessionRef: null,
    currentWorkspace: options.workspace,
    workspaceHistory: [options.workspace],
    processOwner: options.processOwner ?? null,
    processState: "starting",
    retentionState: "retained",
    createdAt: now,
    updatedAt: now,
  };
  const database = await openRuntimeSessionCatalog(options.paths);
  try {
    database.exec("BEGIN IMMEDIATE");
    if (isOwnerDeletionFenced(options.paths, options.owner.ownerId))
      throw new Error("RUNTIME_OWNER_DELETED");
    database
      .prepare(
        `INSERT INTO runtime_sessions(system_session_id, owner_id, owner_type, record_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.systemSessionId,
        record.owner.ownerId,
        record.owner.type,
        JSON.stringify(record),
        record.updatedAt,
      );
    database.exec("COMMIT");
  } catch (error) {
    if (!isConstraint(error)) throw error;
    const existing = database
      .prepare("SELECT owner_id, owner_type FROM runtime_sessions WHERE system_session_id = ?")
      .get(record.systemSessionId) as
      { readonly owner_id: string; readonly owner_type: string } | undefined;
    throw new Error(
      `Runtime Session ${record.systemSessionId} is already owned by ${JSON.stringify(existing)}.`,
      { cause: error },
    );
  } finally {
    database.close();
  }
  return record;
}

export async function restoreRuntimeSessionRecord(options: {
  readonly paths: PragmaPaths;
  readonly owner: RuntimeSessionOwner;
  readonly systemSessionId: string;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly runtimeSession: RuntimeSessionRef;
  readonly workspace: string;
  readonly processOwner?: RuntimeHostProcess | null;
}): Promise<RuntimeSessionRecord> {
  const record = await readRuntimeSessionRecord(
    options.paths,
    options.owner.ownerId,
    options.systemSessionId,
  );
  return await writeRuntimeSessionRecord(options.paths, record, (current) => {
    assertOwner(current.owner, options.owner);
    assertEqual(current.expertId, options.agentId, "Expert");
    assertEqual(current.runtime.id, options.runtime.id, "Runtime descriptor");
    assertEqual(current.runtime.kind, options.runtime.kind, "Runtime type");
    assertEqual(current.runtimeSessionRef?.type, options.runtimeSession.type, "Session type");
    assertEqual(current.runtimeSessionRef?.id, options.runtimeSession.id, "Session id");
    return {
      ...current,
      currentWorkspace: options.workspace,
      workspaceHistory: current.workspaceHistory.includes(options.workspace)
        ? current.workspaceHistory
        : [...current.workspaceHistory, options.workspace],
      processOwner: options.processOwner ?? null,
      processState: "running",
    };
  });
}

export async function rebindRuntimeSessionExpertId(options: {
  readonly paths: PragmaPaths;
  readonly ownerId: string;
  readonly systemSessionId: string;
  readonly fromExpertId: string;
  readonly toExpertId: string;
}): Promise<void> {
  if (options.fromExpertId === options.toExpertId) return;
  const record = await readRuntimeSessionRecord(
    options.paths,
    options.ownerId,
    options.systemSessionId,
  );
  await writeRuntimeSessionRecord(options.paths, record, (current) => {
    assertEqual(current.expertId, options.fromExpertId, "Expert");
    return { ...current, expertId: options.toExpertId };
  });
}

export async function updateRuntimeSessionRecord(
  paths: PragmaPaths,
  record: RuntimeSessionRecord,
  patch: Partial<
    Pick<
      RuntimeSessionRecord,
      "runtimeSessionRef" | "contextWindowUsage" | "processState" | "retentionState"
    >
  >,
): Promise<RuntimeSessionRecord> {
  let changedHost = false;
  const updated = await writeRuntimeSessionRecord(
    paths,
    record,
    (current) => {
      // Native teardown and observations from an old Host can arrive after an
      // explicit restore. They must not rewrite its successor's record.
      const previous = record.processOwner;
      const active = current.processOwner;
      if (
        (previous?.type === "host" || active?.type === "host") &&
        (previous?.type !== "host" ||
          active?.type !== "host" ||
          previous.instanceId !== active.instanceId)
      ) {
        changedHost = true;
        return current;
      }
      return { ...current, ...patch };
    },
    "skip",
  );
  // A retired driver must retain its own identity across later cleanup writes,
  // rather than accidentally adopting the successor identity returned by storage.
  return changedHost ? record : updated;
}

export function readRuntimeSessionContextWindowUsage(
  record: RuntimeSessionRecord,
): RuntimeContextWindowUsage | undefined {
  return record.contextWindowUsage ?? undefined;
}

export async function readRuntimeSessionRecord(
  paths: PragmaPaths,
  ownerId: string,
  systemSessionId: string,
): Promise<RuntimeSessionRecord> {
  const database = await openRuntimeSessionCatalog(paths);
  let loaded: RuntimeSessionRecord;
  try {
    database.exec("BEGIN IMMEDIATE");
    const row = database
      .prepare(
        `SELECT system_session_id AS systemSessionId, owner_id AS ownerId,
                owner_type AS ownerType, record_json AS recordJson
         FROM runtime_sessions WHERE system_session_id = ? AND owner_id = ?`,
      )
      .get(systemSessionId, ownerId) as
      | {
          readonly systemSessionId: string;
          readonly ownerId: string;
          readonly ownerType: string;
          readonly recordJson: string;
        }
      | undefined;
    if (row === undefined) throw new Error(`Runtime Session not found: ${systemSessionId}`);
    const record = upgradeRuntimeSessionCatalogRecord(database, row.recordJson);
    assertEqual(record.systemSessionId, row.systemSessionId, "Catalog system Session id");
    assertEqual(record.owner.ownerId, row.ownerId, "Catalog owner id");
    assertEqual(record.owner.type, row.ownerType, "Catalog owner type");
    database.exec("COMMIT");
    loaded = record;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* BEGIN may have failed before acquiring a transaction. */
    }
    if (error instanceof Error && error.message.startsWith("Runtime Session not found:"))
      throw error;
    throw unsupported(runtimeSessionCatalogPath(paths), error);
  } finally {
    database.close();
  }
  return await reconcileRuntimeHostState(paths, loaded);
}

async function writeRuntimeSessionRecord(
  paths: PragmaPaths,
  record: RuntimeSessionRecord,
  update: (current: RuntimeSessionRecord) => RuntimeSessionRecord,
  onDeletedOwner: "skip" | "reject" = "reject",
): Promise<RuntimeSessionRecord> {
  const database = await openRuntimeSessionCatalog(paths);
  try {
    database.exec("BEGIN IMMEDIATE");
    if (isOwnerDeletionFenced(paths, record.owner.ownerId)) {
      if (onDeletedOwner === "reject") throw new Error("RUNTIME_OWNER_DELETED");
      database.exec("COMMIT");
      return record;
    }
    // Callers can hold an old snapshot while stop, usage and identity writes
    // overlap. Merge only under the catalog write lock, against its latest row.
    const row = database
      .prepare(
        `SELECT record_json AS recordJson FROM runtime_sessions
         WHERE system_session_id = ? AND owner_id = ? AND owner_type = ?`,
      )
      .get(record.systemSessionId, record.owner.ownerId, record.owner.type) as
      { readonly recordJson: string } | undefined;
    if (row === undefined) throw new Error(`Runtime Session not found: ${record.systemSessionId}`);
    const current = upgradeRuntimeSessionCatalogRecord(database, row.recordJson);
    assertEqual(current.systemSessionId, record.systemSessionId, "Catalog system Session id");
    assertOwner(current.owner, record.owner);
    const next = update(current);
    if (next === current) {
      database.exec("COMMIT");
      return current;
    }
    const updated = { ...next, updatedAt: new Date().toISOString() };
    const result = database
      .prepare(
        `UPDATE runtime_sessions SET record_json = ?, updated_at = ?
         WHERE system_session_id = ? AND owner_id = ? AND owner_type = ?`,
      )
      .run(
        JSON.stringify(updated),
        updated.updatedAt,
        record.systemSessionId,
        record.owner.ownerId,
        record.owner.type,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`Runtime Session not found: ${record.systemSessionId}`);
    }
    database.exec("COMMIT");
    return updated;
  } finally {
    database.close();
  }
}

function assertOwner(actual: RuntimeSessionOwner, expected: RuntimeSessionOwner): void {
  assertEqual(actual.type, expected.type, "Owner");
  assertEqual(actual.ownerId, expected.ownerId, "Owner");
  assertEqual(actual.contextId, expected.contextId, "Owner");
  assertEqual(actual.invocationId, expected.invocationId, "Owner");
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch while restoring Runtime Session.`);
}

function unsupported(file: string, cause?: unknown): Error {
  return new Error(`unsupported-state-version: ${file}`, { cause });
}

function isConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("PRIMARY KEY constraint failed"))
  );
}

/** Targeted owner lookup; no Runtime Session directory enumeration. */
export async function readRuntimeSessionsForOwners(
  paths: PragmaPaths,
  ids: readonly string[],
  options: { readonly reconcileHostState?: boolean } = {},
): Promise<readonly RuntimeSessionRecord[]> {
  if (ids.length === 0) return [];
  try {
    await stat(runtimeSessionCatalogPath(paths));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  const database = await openRuntimeSessionCatalog(paths);
  let records: RuntimeSessionRecord[];
  try {
    database.exec("BEGIN IMMEDIATE");
    const rows = database
      .prepare(
        "SELECT owner_id AS ownerId, system_session_id AS systemSessionId, record_json AS recordJson FROM runtime_sessions WHERE owner_id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify([...new Set(ids)])) as unknown as readonly {
      ownerId: string;
      systemSessionId: string;
      recordJson: string;
    }[];
    records = rows.map((row) => {
      const record = upgradeRuntimeSessionCatalogRecord(database, row.recordJson);
      assertEqual(record.owner.ownerId, row.ownerId, "Catalog owner id");
      assertEqual(record.systemSessionId, row.systemSessionId, "Catalog system Session id");
      return record;
    });
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* BEGIN may have failed before acquiring a transaction. */
    }
    throw error;
  } finally {
    database.close();
  }
  if (options.reconcileHostState === false) return records;
  const hostStatuses = new Map<string, ReturnType<typeof runtimeHostProcessStatus>>();
  return await Promise.all(
    records.map(async (record) => await reconcileRuntimeHostState(paths, record, hostStatuses)),
  );
}

/** Repair a targeted in-process record only from evidence of its Host's exit. */
async function reconcileRuntimeHostState(
  paths: PragmaPaths,
  record: RuntimeSessionRecord,
  statuses = new Map<string, ReturnType<typeof runtimeHostProcessStatus>>(),
): Promise<RuntimeSessionRecord> {
  if (
    record.processState === "stopped" ||
    record.processOwner === null ||
    isOwnerDeletionFenced(paths, record.owner.ownerId)
  )
    return record;
  const owner = record.processOwner;
  if (owner.type === "host") {
    const key = JSON.stringify([owner.processId, owner.processStartToken]);
    const status = statuses.get(key) ?? runtimeHostProcessStatus(owner);
    statuses.set(key, status);
    if ((await status) !== "dead") return record;
    return await writeRuntimeSessionRecord(
      paths,
      record,
      (current) =>
        current.processOwner?.type === "host" &&
        current.processOwner.instanceId === owner.instanceId
          ? { ...current, processState: "stopped" }
          : current,
      "skip",
    );
  }
  if (record.owner.type !== "expert-session") return record;
  // A legacy Pi record has no invented Host identity. Its owner's historical
  // lease can still positively prove exit. Hold the same lock as lease takeover.
  return await withFileLock(
    paths.expertSessionLock(record.owner.ownerId),
    async () => {
      let lease;
      try {
        lease = ExpertSessionLeaseSchema.parse(
          JSON.parse(await readFile(paths.expertSessionLease(record.owner.ownerId), "utf8")),
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return record;
        throw error;
      }
      if (
        lease.processId === undefined ||
        (await runtimeHostProcessStatus({
          processId: lease.processId,
          processStartToken: null,
        })) !== "dead"
      )
        return record;
      return await writeRuntimeSessionRecord(
        paths,
        record,
        (current) =>
          current.processOwner?.type === "legacy-host"
            ? { ...current, processState: "stopped" }
            : current,
        "skip",
      );
    },
    { operation: "runtime-session.legacy-host-recovery" },
  );
}
