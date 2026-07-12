import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  RuntimeAdapterDescriptor,
  RuntimeSessionOwner,
  RuntimeSessionRef,
} from "./runtime-adapter.ts";
import { RuntimeSessionRefSchema } from "./runtime-adapter.ts";
import type { PragmaPaths } from "../storage/pragma-paths.ts";

export type RuntimeSessionRecordStatus = "creating" | "active" | "closed" | "failed";

export interface RuntimeSessionRecord {
  readonly schemaVersion: 1;
  readonly workflowRunId: string;
  readonly systemSessionId: string;
  readonly agentId: string;
  readonly taskRunId?: string | undefined;
  readonly runtime: Pick<RuntimeAdapterDescriptor, "id" | "kind">;
  readonly runtimeSessionRef: RuntimeSessionRef | null;
  readonly currentWorkspace: string;
  readonly workspaceHistory: readonly string[];
  readonly status: RuntimeSessionRecordStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

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
    options.owner.workflowRunId,
    options.systemSessionId,
  );
  const now = new Date().toISOString();
  const record: RuntimeSessionRecord = {
    schemaVersion: 1,
    workflowRunId: options.owner.workflowRunId,
    systemSessionId: options.systemSessionId,
    agentId: options.agentId,
    ...(options.owner.taskRunId === undefined ? {} : { taskRunId: options.owner.taskRunId }),
    runtime: { id: options.runtime.id, kind: options.runtime.kind },
    runtimeSessionRef: null,
    currentWorkspace: options.workspace,
    workspaceHistory: [options.workspace],
    status: "creating",
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
  readonly expectedTaskRunId?: string | undefined;
  readonly workspace: string;
}): Promise<RuntimeSessionRecord> {
  const record = await readRuntimeSessionRecord(
    options.paths,
    options.owner.workflowRunId,
    options.systemSessionId,
  );
  assertEqual(record.workflowRunId, options.owner.workflowRunId, "Workflow");
  if (options.expectedTaskRunId !== undefined) {
    assertEqual(record.taskRunId, options.expectedTaskRunId, "Task");
  }
  assertEqual(record.systemSessionId, options.systemSessionId, "System session");
  assertEqual(record.agentId, options.agentId, "Agent");
  assertEqual(record.runtime.id, options.runtime.id, "Runtime descriptor");
  assertEqual(record.runtime.kind, options.runtime.kind, "Runtime type");
  assertEqual(record.runtimeSessionRef?.type, options.runtimeSession.type, "Runtime session type");
  assertEqual(record.runtimeSessionRef?.id, options.runtimeSession.id, "Runtime session id");

  const workspaceHistory = record.workspaceHistory.includes(options.workspace)
    ? record.workspaceHistory
    : [...record.workspaceHistory, options.workspace];
  const updated = {
    ...record,
    currentWorkspace: options.workspace,
    workspaceHistory,
    status: "active" as const,
    updatedAt: new Date().toISOString(),
  };
  await writeRuntimeSessionRecord(options.paths, updated);
  return updated;
}

export async function restoreOrCreateRuntimeSessionRecord(options: {
  readonly pragmaPaths: PragmaPaths;
  readonly owner: RuntimeSessionOwner;
  readonly systemSessionId: string;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly runtimeSession: RuntimeSessionRef;
  readonly expectedTaskRunId?: string | undefined;
  readonly workspace: string;
}): Promise<RuntimeSessionRecord> {
  try {
    return await restoreRuntimeSessionRecord({
      paths: options.pragmaPaths,
      owner: options.owner,
      systemSessionId: options.systemSessionId,
      agentId: options.agentId,
      runtime: options.runtime,
      runtimeSession: options.runtimeSession,
      expectedTaskRunId: options.expectedTaskRunId,
      workspace: options.workspace,
    });
  } catch (error) {
    if (!isSessionRecordNotFoundError(error)) {
      throw error;
    }
  }
  return await createRuntimeSessionRecord({
    paths: options.pragmaPaths,
    owner: options.owner,
    systemSessionId: options.systemSessionId,
    agentId: options.agentId,
    runtime: options.runtime,
    workspace: options.workspace,
  });
}

export async function updateRuntimeSessionRecord(
  paths: PragmaPaths,
  record: RuntimeSessionRecord,
  patch: Partial<Pick<RuntimeSessionRecord, "runtimeSessionRef" | "status">>,
): Promise<RuntimeSessionRecord> {
  const updated = { ...record, ...patch, updatedAt: new Date().toISOString() };
  await writeRuntimeSessionRecord(paths, updated);
  return updated;
}

export async function readRuntimeSessionRecord(
  paths: PragmaPaths,
  workflowRunId: string,
  systemSessionId: string,
): Promise<RuntimeSessionRecord> {
  const manifestPath = paths.systemSessionManifest(workflowRunId, systemSessionId);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(
        `Runtime system session was not found: ${systemSessionId} in workflow ${workflowRunId}.`,
        { cause: error },
      );
    }
    throw error;
  }
  return assertRuntimeSessionRecord(value, manifestPath);
}

async function writeRuntimeSessionRecord(
  paths: PragmaPaths,
  record: RuntimeSessionRecord,
): Promise<void> {
  const manifestPath = paths.systemSessionManifest(record.workflowRunId, record.systemSessionId);
  await mkdir(dirname(manifestPath), { recursive: true });
  const temporaryPath = join(dirname(manifestPath), `.session.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function claimSystemSessionOwner(
  paths: PragmaPaths,
  workflowRunId: string,
  systemSessionId: string,
): Promise<string> {
  const ownershipPath = paths.systemSessionOwner(systemSessionId);
  await mkdir(dirname(ownershipPath), { recursive: true });
  const ownership = {
    schemaVersion: 1,
    systemSessionId,
    workflowRunId,
    createdAt: new Date().toISOString(),
  };

  let claimError: unknown;
  try {
    await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return ownershipPath;
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    claimError = error;
  }

  const existingOwner = await readSystemSessionOwner(ownershipPath);
  throw new Error(
    `System session ${systemSessionId} is already owned by workflow ${existingOwner.workflowRunId}; cannot create it for workflow ${workflowRunId}.`,
    { cause: claimError },
  );
}

async function readSystemSessionOwner(
  ownershipPath: string,
): Promise<{ readonly workflowRunId: string }> {
  const value = JSON.parse(await readFile(ownershipPath, "utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("workflowRunId" in value) ||
    typeof value.workflowRunId !== "string"
  ) {
    throw new Error(`Invalid system session ownership record: ${ownershipPath}.`);
  }
  return { workflowRunId: value.workflowRunId };
}

function assertRuntimeSessionRecord(value: unknown, path: string): RuntimeSessionRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid runtime session record: ${path}.`);
  }
  const record = value as Partial<RuntimeSessionRecord>;
  const runtime = record.runtime;
  const runtimeSessionRef = record.runtimeSessionRef;
  if (
    record.schemaVersion !== 1 ||
    typeof record.workflowRunId !== "string" ||
    typeof record.systemSessionId !== "string" ||
    typeof record.agentId !== "string" ||
    (record.taskRunId !== undefined && typeof record.taskRunId !== "string") ||
    typeof record.currentWorkspace !== "string" ||
    !Array.isArray(record.workspaceHistory) ||
    !record.workspaceHistory.every((workspace) => typeof workspace === "string") ||
    typeof runtime !== "object" ||
    runtime === null ||
    typeof runtime.id !== "string" ||
    typeof runtime.kind !== "string" ||
    (runtimeSessionRef !== null && !RuntimeSessionRefSchema.safeParse(runtimeSessionRef).success) ||
    !isRuntimeSessionRecordStatus(record.status) ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    throw new Error(`Invalid runtime session record: ${path}.`);
  }
  return record as RuntimeSessionRecord;
}

function isRuntimeSessionRecordStatus(value: unknown): value is RuntimeSessionRecordStatus {
  return value === "creating" || value === "active" || value === "closed" || value === "failed";
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected)
    throw new Error(
      `${label} mismatch while restoring runtime session: expected ${String(expected)}, found ${String(actual)}.`,
    );
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSessionRecordNotFoundError(error: unknown): boolean {
  if (error instanceof Error && error.cause !== undefined) {
    return isNotFoundError(error.cause);
  }
  return false;
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
