import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  PragmaPaths,
  decodePragmaPathSegment,
  encodePragmaPathSegment,
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
  writeStateMigrationBackup,
  withFileLock,
  recoverRuntimeSessionDeletion,
  StorageDeletionJournalSchema,
  type PragmaLogger,
} from "@pragma/core";
import { z } from "zod";
import {
  MissionDeletionRecordSchema,
  missionDeletionMigrationChain,
  type MissionDeletionRecord,
} from "./deletion-migrations/index.ts";
import { stopHistoricalRuntimeProcesses } from "./historical-runtime-stop.ts";
import { createIntegrationError } from "@pragma/shared/integration";

export const MISSION_DELETION_STEPS = [
  "usage",
  "memory",
  "drafts",
  "claims",
  "settlement",
] as const;
export type MissionDeletionStep = (typeof MISSION_DELETION_STEPS)[number];
export const MISSION_DELETION_MAX_RETRIES = 10;
const RETRY_EXHAUSTED = "mission.delete_cleanup_retry_exhausted";
export {
  MissionDeletionRecordSchema,
  type MissionDeletionRecord,
} from "./deletion-migrations/index.ts";
export type MissionDeletionPorts = Record<
  MissionDeletionStep,
  (record: MissionDeletionRecord, signal: AbortSignal) => Promise<void>
>;

export async function readMissionDeletionRecord(
  paths: PragmaPaths,
  id: string,
): Promise<MissionDeletionRecord | undefined> {
  return await withFileLock(
    `${paths.missionDeletion(id)}.lock`,
    async () => await readMissionDeletionRecordUnlocked(paths, id),
    { operation: "mission-deletion.read" },
  );
}

async function readMissionDeletionRecordUnlocked(
  paths: PragmaPaths,
  id: string,
): Promise<MissionDeletionRecord | undefined> {
  for (const path of [paths.missionDeletion(id), paths.missionDeletionCompleted(id)]) {
    try {
      const resource = { family: "pragma.mission-deletion", id };
      const validateDocuments = (documents: Readonly<Record<string, unknown>>) => {
        if (
          Object.keys(documents).length !== 1 ||
          MissionDeletionRecordSchema.parse(documents[basename(path)]).missionId !== id
        )
          throw new Error("Mission deletion migration owner mismatch.");
      };
      await recoverAtomicStateMigration({
        aggregateRoot: dirname(path),
        journalFile: `${path}.migration`,
        resource,
        validateDocuments,
      });
      const source = await readFile(path, "utf8");
      const upgraded = missionDeletionMigrationChain.upgrade(JSON.parse(source));
      const record = upgraded.value;
      if (record.missionId !== id)
        throw createIntegrationError({
          code: "STORAGE_CORRUPTED",
          category: "protocol",
          message: `Mission ${id} deletion record belongs to another owner.`,
          details: {
            missionId: id,
            stage: "deletion-record.read",
            file: relative(paths.root, path),
            reason: "owner_mismatch",
          },
        });
      if (upgraded.migrated) {
        const backup = join(
          paths.archivesRoot(),
          "storage-migrations",
          "mission-deletion-v2",
          encodePragmaPathSegment(id),
          path === paths.missionDeletion(id) ? "pending.json" : "completed.json",
        );
        await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
        await writeStateMigrationBackup(backup, source);
        await applyAtomicStateMigration({
          aggregateRoot: dirname(path),
          journalFile: `${path}.migration`,
          resource,
          fromVersion: upgraded.fromVersion,
          toVersion: upgraded.toVersion,
          documents: { [basename(path)]: record },
          validateDocuments,
        });
      }
      return record;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return undefined;
}

export async function isMissionDeletionCommitted(paths: PragmaPaths, id: string): Promise<boolean> {
  const record = await readMissionDeletionRecord(paths, id);
  if (record === undefined) return false;
  if (record.phase !== "prepared") return true;
  const file = join(paths.deletionJournalRoot(), `${record.deletionId}.json`);
  let journal;
  try {
    journal = StorageDeletionJournalSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (
    journal.deletionId !== record.deletionId ||
    journal.owner.id !== id ||
    journal.owner.type !== "mission"
  )
    throw createIntegrationError({
      code: "STORAGE_CORRUPTED",
      category: "protocol",
      message: `Mission ${id} storage deletion journal owner does not match its deletion record.`,
      details: {
        missionId: id,
        stage: "deletion-journal.read",
        file: relative(paths.root, file),
        reason: "owner_mismatch",
      },
    });
  // The physical move is authoritative even if the Host callback never ran.
  if (journal.status === "trashed") return true;
  // A crash can also precede the final journal update. Do not recreate an
  // owner already present in trash while targeted recovery is still pending.
  const owner = journal.sources.find((source) => source.label === "mission");
  if (owner === undefined) return false;
  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  };
  return (
    (await exists(join(paths.trashRoot(), record.deletionId, owner.label))) &&
    !(await exists(owner.path))
  );
}

export class MissionDeletionSourceExpiredError extends Error {
  readonly code = "MISSION_DELETE_USAGE_SOURCE_EXPIRED";
  constructor() {
    super("Deleted Mission usage source has expired.");
  }
}
const BACKOFF = [1_000, 5_000, 30_000, 60_000];
const missing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** Host-owned post-commit work; callback execution never holds an aggregate lock. */
export function createMissionDeletionService(options: {
  readonly paths: PragmaPaths;
  readonly ports: MissionDeletionPorts;
  readonly logger: PragmaLogger;
  readonly stepTimeoutMs?: number;
}) {
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const settlements = new Map<string, () => Promise<void>>();
  const pending = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();
  const read = async (id: string) => await readMissionDeletionRecord(options.paths, id);
  const save = async (record: MissionDeletionRecord): Promise<void> => {
    const path =
      record.phase === "completed"
        ? options.paths.missionDeletionCompleted(record.missionId)
        : options.paths.missionDeletion(record.missionId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(MissionDeletionRecordSchema.parse(record)), {
      mode: 0o600,
    });
    await rename(tmp, path);
    if (record.phase === "completed")
      await rm(options.paths.missionDeletion(record.missionId), { force: true });
  };
  const mutate = async (
    id: string,
    action: (record: MissionDeletionRecord) => MissionDeletionRecord,
  ): Promise<void> => {
    await withFileLock(
      `${options.paths.missionDeletion(id)}.lock`,
      async () => {
        const record = await readMissionDeletionRecordUnlocked(options.paths, id);
        if (record === undefined) throw new Error("Mission deletion record is missing.");
        const updated = action(record);
        if (updated !== record) await save(updated);
      },
      { operation: "mission-deletion.progress" },
    );
  };
  const commit = async (id: string) =>
    await mutate(id, (record) =>
      record.phase === "prepared" ? { ...record, phase: "committed" } : record,
    );
  const runStep = async (
    record: MissionDeletionRecord,
    step: MissionDeletionStep,
  ): Promise<void> => {
    const key = `${record.missionId}:${step}`;
    if (pending.has(key)) return;
    let releaseWorker!: () => void;
    const workerReleased = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const locked = withFileLock(
      `${options.paths.missionDeletion(record.missionId)}.${step}.lock`,
      async () => {
        if (pending.has(key)) return;
        let admittedRecord: MissionDeletionRecord | undefined;
        await mutate(record.missionId, (current) => {
          const state = current.steps[step];
          if (current.phase !== "committed" || state.done || state.nextAt > Date.now())
            return current;
          if (state.runs > 0 && current.retryAttempts >= MISSION_DELETION_MAX_RETRIES) {
            errors.set(key, RETRY_EXHAUSTED);
            if (step === "settlement") settlements.delete(record.missionId);
            return current;
          }
          admittedRecord = {
            ...current,
            retryAttempts: current.retryAttempts + (state.runs > 0 ? 1 : 0),
            steps: { ...current.steps, [step]: { ...state, runs: state.runs + 1 } },
          };
          return admittedRecord;
        });
        const fresh = admittedRecord;
        if (fresh === undefined) return;
        const stepStartedAt = performance.now();
        const abort = new AbortController();
        const operation = Promise.resolve().then(async () => {
          const cleanups = [Promise.resolve().then(() => options.ports[step](fresh, abort.signal))];
          if (step === "settlement") {
            cleanups.push(Promise.resolve().then(() => settlements.get(fresh.missionId)?.()));
            // Existing payload fields retain the owner graph across Host restarts.
            // Orphan teardown proceeds even while a native close is unresponsive.
            cleanups.push(
              (async () => {
                const sessionIds = z.array(z.string().min(1)).parse(fresh.payload.sessionIds ?? []);
                // New deletions distinguish in-process hosts from independent CLI
                // children. Legacy deletion records retain their existing fallback.
                const ownerIds = z
                  .array(z.string().min(1))
                  .parse(
                    fresh.payload.runtimeProcessOwnerIds ?? [...sessionIds, ...fresh.executionIds],
                  );
                try {
                  await stopHistoricalRuntimeProcesses(
                    options.paths,
                    ownerIds,
                    fresh.steps.settlement.attempts > 0 ? "SIGKILL" : "SIGTERM",
                  );
                } catch (error) {
                  if (
                    !(error instanceof Error) ||
                    error.message !== "MISSION_DELETE_PROCESS_CLEANUP_PENDING" ||
                    fresh.steps.settlement.attempts > 0
                  )
                    throw error;
                  // Escalate independently of native close: it may be waiting on
                  // the very child that ignored SIGTERM. Keep the worker lease.
                  await new Promise<void>((resolve) => setTimeout(resolve, 250));
                  await stopHistoricalRuntimeProcesses(options.paths, ownerIds, "SIGKILL");
                }
              })(),
            );
          }
          const outcomes = await Promise.allSettled(cleanups);
          const failure = outcomes.find((outcome) => outcome.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        });
        pending.set(key, operation);
        void operation.then(
          () => pending.delete(key),
          () => pending.delete(key),
        );
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => {
                abort.abort();
                reject(new Error("MISSION_DELETE_CLEANUP_TIMEOUT"));
              }, options.stepTimeoutMs ?? 5_000);
            }),
          ]);
          await mutate(record.missionId, (current) => ({
            ...current,
            steps: {
              ...current.steps,
              [step]: { ...current.steps[step], done: true, errorCode: undefined },
            },
          }));
          errors.delete(key);
          if (step === "settlement") settlements.delete(record.missionId);
        } catch (error) {
          const expired = step === "usage" && error instanceof MissionDeletionSourceExpiredError;
          const code = expired ? error.code : "MISSION_DELETE_CLEANUP_RETRY_PENDING";
          await mutate(record.missionId, (current) => {
            const attempts = current.steps[step].attempts + 1;
            return {
              ...current,
              steps: {
                ...current.steps,
                [step]: {
                  ...current.steps[step],
                  done: expired,
                  attempts,
                  nextAt: Date.now() + BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)]!,
                  errorCode: code,
                },
              },
            };
          });
          errors.set(key, code);
          options.logger.warn(
            "mission.deletion_cleanup_degraded",
            "Mission deletion committed; background cleanup needs attention.",
            {
              moduleId: "pragma.mission-deletion",
              missionId: record.missionId,
              step,
              errorCode: code,
              error,
            },
          );
        } finally {
          if (deadline !== undefined) clearTimeout(deadline);
          // Keep the cross-process lease until an uncooperative callback exits.
          // Other independent steps may advance after its timeout.
          options.logger.info(
            "mission.deletion_cleanup_phase",
            "Mission cleanup step settled or timed out.",
            {
              moduleId: "pragma.mission-deletion",
              missionId: record.missionId,
              step,
              durationMs: performance.now() - stepStartedAt,
            },
          );
          releaseWorker();
          await operation.catch(() => undefined);
        }
      },
      { operation: `mission-deletion.${step}` },
    );
    void locked.catch((error: unknown) => {
      errors.set(key, "MISSION_DELETE_CLEANUP_RETRY_PENDING");
      options.logger.warn("mission.deletion_step_lock_failed", "Background cleanup lease failed.", {
        moduleId: "pragma.mission-deletion",
        missionId: record.missionId,
        step,
        error,
      });
    });
    await Promise.race([locked, workerReleased]);
  };
  const runBatch = async (): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(options.paths.missionDeletionRoot());
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const tasks: { record: MissionDeletionRecord; step: MissionDeletionStep }[] = [];
    const finalizeIds = new Set<string>();
    for (const name of names.filter((name) => name.endsWith(".json"))) {
      let record: MissionDeletionRecord;
      try {
        const id = decodePragmaPathSegment(name.slice(0, -5));
        const loaded = await read(id);
        if (loaded === undefined) continue;
        record = loaded;
      } catch (error) {
        errors.set(name, "MISSION_DELETE_RECORD_INVALID");
        options.logger.warn(
          "mission.deletion_record_invalid",
          "A Mission deletion record needs inspection.",
          {
            moduleId: "pragma.mission-deletion",
            errorCode: "MISSION_DELETE_RECORD_INVALID",
            error,
          },
        );
        continue;
      }
      // A durable Host commit is sufficient after trash and its journal expire.
      // Only the prepare/commit crash window requires transaction recovery.
      if (record.phase === "prepared") {
        // An intent with no storage journal is waiting for an explicit delete,
        // rather than a failed background recovery attempt.
        try {
          await stat(join(options.paths.deletionJournalRoot(), `${record.deletionId}.json`));
        } catch (error) {
          if (missing(error)) continue;
        }
        let admitted = false;
        await mutate(record.missionId, (current) => {
          if (current.phase !== "prepared") return current;
          if (current.retryAttempts >= MISSION_DELETION_MAX_RETRIES) {
            errors.set(current.missionId, RETRY_EXHAUSTED);
            settlements.delete(current.missionId);
            return current;
          }
          admitted = true;
          return { ...current, retryAttempts: current.retryAttempts + 1 };
        });
        if (!admitted) continue;
        try {
          let journal = StorageDeletionJournalSchema.parse(
            JSON.parse(
              await readFile(
                join(options.paths.deletionJournalRoot(), `${record.deletionId}.json`),
                "utf8",
              ),
            ),
          );
          if (
            journal.schemaVersion !== "pragma.storage-deletion/v1" ||
            journal.deletionId !== record.deletionId ||
            journal.owner.id !== record.missionId ||
            journal.owner.type !== "mission"
          )
            throw new Error("Mission deletion transaction mismatch.");
          if (journal.status !== "trashed") {
            await recoverRuntimeSessionDeletion(options.paths, record.deletionId);
            journal = StorageDeletionJournalSchema.parse(
              JSON.parse(
                await readFile(
                  join(options.paths.deletionJournalRoot(), `${record.deletionId}.json`),
                  "utf8",
                ),
              ),
            );
          }
          if (journal.status === "trashed") {
            await commit(record.missionId);
            record = (await read(record.missionId))!;
            errors.delete(record.missionId);
          }
        } catch (error) {
          if (!missing(error)) {
            errors.set(record.missionId, "MISSION_DELETE_RECOVERY_FAILED");
            options.logger.warn(
              "mission.deletion_recovery_failed",
              "A Mission deletion transaction needs inspection.",
              {
                moduleId: "pragma.mission-deletion",
                missionId: record.missionId,
                errorCode: "MISSION_DELETE_RECOVERY_FAILED",
                error,
              },
            );
          }
          continue;
        }
      }
      for (const step of MISSION_DELETION_STEPS) {
        if (record.steps[step].errorCode !== undefined)
          errors.set(`${record.missionId}:${step}`, record.steps[step].errorCode!);
      }
      if (record.phase !== "committed") continue;
      if (MISSION_DELETION_STEPS.every((step) => record.steps[step].done))
        finalizeIds.add(record.missionId);
      for (const step of MISSION_DELETION_STEPS) {
        if (
          !record.steps[step].done &&
          record.steps[step].runs > 0 &&
          record.retryAttempts >= MISSION_DELETION_MAX_RETRIES
        ) {
          errors.set(`${record.missionId}:${step}`, RETRY_EXHAUSTED);
          // No further admission can use this closure. Drop retained native
          // Session/Execution references; durable failure evidence stays on disk.
          if (step === "settlement") settlements.delete(record.missionId);
          continue;
        }
        if (
          !record.steps[step].done &&
          record.steps[step].nextAt <= Date.now() &&
          !pending.has(`${record.missionId}:${step}`)
        ) {
          tasks.push({ record, step });
          finalizeIds.add(record.missionId);
        }
      }
    }
    let index = 0;
    await Promise.all(
      [0, 1].map(async () => {
        while (index < tasks.length) {
          const task = tasks[index++];
          if (task !== undefined) await runStep(task.record, task.step);
        }
      }),
    );
    for (const id of finalizeIds) {
      await mutate(id, (record) =>
        record.phase === "committed" &&
        MISSION_DELETION_STEPS.every((step) => record.steps[step].done)
          ? { ...record, payload: {}, phase: "completed" }
          : record,
      );
    }
  };
  let batch: Promise<void> | undefined;
  const runOnce = (): Promise<void> => {
    if (batch !== undefined) return batch;
    batch = runBatch().finally(() => {
      batch = undefined;
    });
    return batch;
  };
  const wake = () => {
    if (!started || running !== undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    running = runOnce()
      .catch((error: unknown) => {
        errors.set("worker", "MISSION_DELETE_RECOVERY_FAILED");
        options.logger.warn(
          "mission.deletion_recovery_failed",
          "Mission deletion recovery needs attention.",
          {
            moduleId: "pragma.mission-deletion",
            errorCode: "MISSION_DELETE_RECOVERY_FAILED",
            error,
          },
        );
      })
      .finally(() => {
        running = undefined;
        if (started) {
          timer = setTimeout(wake, 1_000);
          timer.unref();
        }
      });
  };
  return {
    read,
    trackSettlement(id: string, cleanup: () => Promise<void>) {
      settlements.set(id, cleanup);
    },
    commit,
    async updateOwners(
      id: string,
      executionIds: readonly string[],
      payload: Record<string, unknown>,
    ) {
      await mutate(id, (record) => {
        if (record.phase !== "prepared") throw new Error("Mission deletion already committed.");
        return { ...record, executionIds: [...new Set(executionIds)], payload };
      });
    },
    runOnce,
    wake,
    async prepare(input: {
      missionId: string;
      executionIds: readonly string[];
      payload: Record<string, unknown>;
      missionPath?: string;
    }): Promise<MissionDeletionRecord> {
      return await withFileLock(
        `${options.paths.missionDeletion(input.missionId)}.lock`,
        async () => {
          const existing = await readMissionDeletionRecordUnlocked(options.paths, input.missionId);
          if (existing !== undefined) return existing;
          const step = () => ({ done: false, attempts: 0, runs: 0, nextAt: 0 });
          const record = MissionDeletionRecordSchema.parse({
            schemaVersion: "pragma.mission-deletion/v2",
            retryAttempts: 0,
            ...input,
            deletionId: randomUUID(),
            phase: "prepared",
            executionIds: [...new Set(input.executionIds)],
            createdAt: new Date().toISOString(),
            steps: {
              usage: step(),
              memory: step(),
              drafts: step(),
              claims: step(),
              settlement: step(),
            },
          });
          await save(record);
          return record;
        },
        { operation: "mission-deletion.prepare" },
      );
    },
    start() {
      started = true;
      wake();
    },
    close() {
      started = false;
      if (timer !== undefined) clearTimeout(timer);
    },
    inspect() {
      return {
        state: errors.size === 0 ? ("healthy" as const) : ("degraded" as const),
        pending: pending.size,
        errorCode: errors.values().next().value,
      };
    },
  };
}
export type MissionDeletionService = ReturnType<typeof createMissionDeletionService>;
