import { basename } from "node:path";
import {
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
  withFileLock,
  writeStateMigrationBackup,
} from "@pragma/core";
import { executionSnapshotV1ToV2Step } from "./migrations/execution-snapshot/index.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RuntimeModelSelectionSchema } from "@pragma/shared";
import { PragmaResourceSchema } from "@pragma/interpreter/ast";

const ModelOverrideSchema = z.object({
  runtimeId: z.string().min(1),
  permissionModeId: z.string().min(1).optional(),
  modelSelection: RuntimeModelSelectionSchema.optional(),
});

/** Declarative inputs only: native Sessions, callbacks and credentials stay with their owners. */
export const MissionExecutionSnapshotSchema = z.object({
  schemaVersion: z.literal("pragma.mission-execution-snapshot/v2"),
  missionId: z.string().min(1),
  project: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
  executorRef: z.string().min(1),
  resources: z.array(PragmaResourceSchema),
  fingerprints: z.array(z.tuple([z.string(), z.string()])),
  capabilities: z.array(
    z.object({
      capabilityId: z.string().min(1),
      resolvedRevision: z.number().int().positive(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  pluginRefs: z.array(z.string().min(1)),
  sources: z.record(
    z.string(),
    z.object({
      expertResource: PragmaResourceSchema.optional(),
      additionalResources: z.array(PragmaResourceSchema),
      rootExecutionOverride: ModelOverrideSchema.optional(),
      rootModelSelectionOverride: RuntimeModelSelectionSchema.optional(),
      defaultModelSelection: RuntimeModelSelectionSchema.optional(),
    }),
  ),
});

export type MissionExecutionSnapshot = z.infer<typeof MissionExecutionSnapshotSchema>;

type SnapshotIdentity = Pick<MissionExecutionSnapshot, "missionId" | "project" | "executorRef">;

function assertSnapshotIdentity(snapshot: SnapshotIdentity, expected: SnapshotIdentity): void {
  if (
    snapshot.missionId !== expected.missionId ||
    snapshot.project.id !== expected.project.id ||
    snapshot.project.revision !== expected.project.revision ||
    snapshot.executorRef !== expected.executorRef
  ) {
    throw new Error(`mission_execution_snapshot_identity_mismatch: ${expected.missionId}`);
  }
}

async function readOptionalSnapshotText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseSnapshotForRecovery(source: string): MissionExecutionSnapshot {
  const value: unknown = JSON.parse(source);
  return (value as { schemaVersion?: unknown } | null)?.schemaVersion ===
    "pragma.mission-execution-snapshot/v1"
    ? executionSnapshotV1ToV2Step.migrate(value)
    : MissionExecutionSnapshotSchema.parse(value);
}

export async function readMissionExecutionSnapshot(
  path: string,
  expected?: SnapshotIdentity,
): Promise<MissionExecutionSnapshot | undefined> {
  const journalFile = `${path}.schema-migration.json`;
  if (
    (await readOptionalSnapshotText(path)) === undefined &&
    (await readOptionalSnapshotText(journalFile)) === undefined
  )
    return undefined;
  return await withFileLock(`${path}.schema-migration.lock`, async () => {
    const aggregateRoot = dirname(path);
    const document = basename(path);
    const resource = { family: "pragma.mission-execution-snapshot", id: document };
    const source = await readOptionalSnapshotText(path);
    if (source === undefined && (await readOptionalSnapshotText(journalFile)) === undefined)
      return undefined;
    // Validate the persisted version before replay; an older journal cannot downgrade a future document.
    // A genuine prepared upgrade has already installed its complete original backup.
    const original = parseSnapshotForRecovery(
      source ?? (await readFile(`${path}.v1.backup.json`, "utf8")),
    );
    if (expected !== undefined) assertSnapshotIdentity(original, expected);
    const validateDocuments = (documents: Readonly<Record<string, unknown>>) => {
      if (Object.keys(documents).length !== 1 || !(document in documents))
        throw new Error("Invalid execution snapshot migration target.");
      const target = MissionExecutionSnapshotSchema.parse(documents[document]);
      assertSnapshotIdentity(target, original);
    };
    await recoverAtomicStateMigration({ aggregateRoot, journalFile, resource, validateDocuments });
    const persisted = await readFile(path, "utf8");
    const value: unknown = JSON.parse(persisted);
    const target = parseSnapshotForRecovery(persisted);
    assertSnapshotIdentity(target, original);
    if (
      (value as { schemaVersion?: unknown }).schemaVersion !==
      "pragma.mission-execution-snapshot/v1"
    )
      return target;
    await writeStateMigrationBackup(`${path}.v1.backup.json`, persisted);
    await applyAtomicStateMigration({
      aggregateRoot,
      journalFile,
      resource,
      fromVersion: 1,
      toVersion: 2,
      documents: { [document]: target },
      validateDocuments,
    });
    return target;
  });
}

/** Caller holds the snapshot lock; rename is the only commit point. */
export async function writeMissionExecutionSnapshot(
  path: string,
  snapshot: MissionExecutionSnapshot,
): Promise<void> {
  const value = MissionExecutionSnapshotSchema.parse(snapshot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Deletion-time query only; snapshots are strong references for their Mission's lifetime. */
export async function missionExecutionSnapshotsReference(
  missionsPath: string,
  target: { readonly capabilityId: string } | { readonly pluginRef: string },
): Promise<boolean> {
  const entries = await readdir(missionsPath, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const snapshot = await readMissionExecutionSnapshot(
      join(missionsPath, entry.name, "execution-snapshot.json"),
    );
    if (snapshot === undefined) continue;
    if ("capabilityId" in target) {
      if (snapshot.capabilities.some((pin) => pin.capabilityId === target.capabilityId))
        return true;
    } else {
      if (snapshot.pluginRefs.includes(target.pluginRef)) return true;
      const resources = [
        ...snapshot.resources,
        ...Object.values(snapshot.sources).flatMap((source) => [
          ...source.additionalResources,
          ...(source.expertResource === undefined ? [] : [source.expertResource]),
        ]),
      ];
      if (
        resources.some(
          (resource) =>
            resource.kind === "Expert" &&
            resource.spec.plugins.some((plugin) => plugin.ref === target.pluginRef),
        )
      )
        return true;
    }
  }
  return false;
}
