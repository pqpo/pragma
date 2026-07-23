import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  runtimeSessionRecordMigrationChain,
  type RuntimeSessionRecord,
} from "../storage/migrations/runtime-session/index.ts";
import type { PragmaPaths } from "../storage/pragma-paths.ts";
import type {
  RuntimeAdapterDescriptor,
  RuntimeSessionOwner,
  RuntimeSessionRef,
} from "./runtime-adapter.ts";

export type { RuntimeSessionRecord };
export type RuntimeSessionProcessState = RuntimeSessionRecord["processState"];
export type RuntimeSessionRetentionState = RuntimeSessionRecord["retentionState"];

export async function createRuntimeSessionRecord(options: {
  readonly paths: PragmaPaths;
  readonly owner: RuntimeSessionOwner;
  readonly systemSessionId: string;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly workspace: string;
}): Promise<RuntimeSessionRecord> {
  const ownershipPath = await claimSystemSessionOwner(
    options.paths,
    options.owner,
    options.systemSessionId,
  );
  const now = new Date().toISOString();
  const record: RuntimeSessionRecord = {
    schemaVersion: "pragma.runtime-session/v2",
    owner: options.owner,
    systemSessionId: options.systemSessionId,
    expertId: options.agentId,
    runtime: { id: options.runtime.id, kind: options.runtime.kind },
    runtimeSessionRef: null,
    currentWorkspace: options.workspace,
    workspaceHistory: [options.workspace],
    processState: "starting",
    retentionState: "retained",
    createdAt: now,
    updatedAt: now,
  };
  try {
    await writeRuntimeSessionRecord(options.paths, record);
  } catch (error) {
    await rm(ownershipPath, { force: true }).catch(() => undefined);
    throw error;
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
}): Promise<RuntimeSessionRecord> {
  const record = await readRuntimeSessionRecord(
    options.paths,
    options.owner.ownerId,
    options.systemSessionId,
  );
  assertEqual(JSON.stringify(record.owner), JSON.stringify(options.owner), "Owner");
  assertEqual(record.expertId, options.agentId, "Expert");
  assertEqual(record.runtime.id, options.runtime.id, "Runtime descriptor");
  assertEqual(record.runtime.kind, options.runtime.kind, "Runtime type");
  assertEqual(record.runtimeSessionRef?.type, options.runtimeSession.type, "Session type");
  assertEqual(record.runtimeSessionRef?.id, options.runtimeSession.id, "Session id");
  const updated: RuntimeSessionRecord = {
    ...record,
    currentWorkspace: options.workspace,
    workspaceHistory: record.workspaceHistory.includes(options.workspace)
      ? record.workspaceHistory
      : [...record.workspaceHistory, options.workspace],
    processState: "running",
    updatedAt: new Date().toISOString(),
  };
  await writeRuntimeSessionRecord(options.paths, updated);
  return updated;
}

export async function updateRuntimeSessionRecord(
  paths: PragmaPaths,
  record: RuntimeSessionRecord,
  patch: Partial<
    Pick<RuntimeSessionRecord, "runtimeSessionRef" | "processState" | "retentionState">
  >,
): Promise<RuntimeSessionRecord> {
  const updated = { ...record, ...patch, updatedAt: new Date().toISOString() };
  await writeRuntimeSessionRecord(paths, updated);
  return updated;
}

export async function readRuntimeSessionRecord(
  paths: PragmaPaths,
  ownerId: string,
  systemSessionId: string,
): Promise<RuntimeSessionRecord> {
  const file = paths.ownedSystemSessionManifest(ownerId, systemSessionId);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`Runtime Session not found: ${systemSessionId}`, { cause: error });
    }
    throw error;
  }
  try {
    const upgraded = runtimeSessionRecordMigrationChain.upgrade(value);
    if (upgraded.migrated) await writeRuntimeSessionRecord(paths, upgraded.value);
    return upgraded.value;
  } catch (error) {
    throw unsupported(file, error);
  }
}

async function writeRuntimeSessionRecord(
  paths: PragmaPaths,
  record: RuntimeSessionRecord,
): Promise<void> {
  const file = paths.ownedSystemSessionManifest(record.owner.ownerId, record.systemSessionId);
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.session.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function claimSystemSessionOwner(
  paths: PragmaPaths,
  owner: RuntimeSessionOwner,
  systemSessionId: string,
): Promise<string> {
  const file = paths.runtimeSessionOwner(systemSessionId);
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(
      file,
      `${JSON.stringify({ schemaVersion: "pragma.runtime-session-owner/v1", systemSessionId, owner }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return file;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = JSON.parse(await readFile(file, "utf8")) as { owner?: RuntimeSessionOwner };
    throw new Error(
      `Runtime Session ${systemSessionId} is already owned by ${JSON.stringify(existing.owner)}.`,
      { cause: error },
    );
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch while restoring Runtime Session.`);
  }
}

function unsupported(file: string, cause?: unknown): Error {
  return new Error(`unsupported-state-version: ${file}`, { cause });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
