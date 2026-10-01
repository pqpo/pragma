import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PragmaPaths,
  withFileLock,
  recoverRuntimeSessionDeletion,
  type PragmaLogger,
} from "@pragma/core";
import { z } from "zod";

export const MISSION_DELETION_STEPS = [
  "usage",
  "memory",
  "drafts",
  "claims",
  "settlement",
] as const;
export type MissionDeletionStep = (typeof MISSION_DELETION_STEPS)[number];
const StepSchema = z
  .object({
    done: z.boolean(),
    attempts: z.number().int().nonnegative(),
    nextAt: z.number().nonnegative(),
    errorCode: z.string().optional(),
  })
  .strict();
export const MissionDeletionRecordSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-deletion/v1"),
    missionId: z.string().min(1),
    deletionId: z.string().uuid(),
    phase: z.enum(["prepared", "committed", "completed"]),
    executionIds: z.array(z.string().min(1)),
    payload: z.record(z.string(), z.unknown()),
    missionPath: z.string().optional(),
    steps: z
      .object({
        usage: StepSchema,
        memory: StepSchema,
        drafts: StepSchema,
        claims: StepSchema,
        settlement: StepSchema,
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MissionDeletionRecord = z.infer<typeof MissionDeletionRecordSchema>;
export type MissionDeletionPorts = Record<
  MissionDeletionStep,
  (record: MissionDeletionRecord, signal: AbortSignal) => Promise<void>
>;

export async function readMissionDeletionRecord(
  paths: PragmaPaths,
  id: string,
): Promise<MissionDeletionRecord | undefined> {
  for (const path of [paths.missionDeletion(id), paths.missionDeletionCompleted(id)]) {
    try {
      return MissionDeletionRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return undefined;
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
  const settlements = new Map<string, Promise<void>>();
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
        const record = await read(id);
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
        const fresh = await read(record.missionId);
        if (
          fresh === undefined ||
          fresh.phase !== "committed" ||
          fresh.steps[step].done ||
          fresh.steps[step].nextAt > Date.now()
        )
          return;
        const stepStartedAt = performance.now();
        const abort = new AbortController();
        const operation = Promise.resolve().then(async () => {
          await options.ports[step](fresh, abort.signal);
          if (step === "settlement") await settlements.get(fresh.missionId);
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
        record = MissionDeletionRecordSchema.parse(
          JSON.parse(await readFile(join(options.paths.missionDeletionRoot(), name), "utf8")),
        );
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
        try {
          let journal = JSON.parse(
            await readFile(
              join(options.paths.deletionJournalRoot(), `${record.deletionId}.json`),
              "utf8",
            ),
          ) as {
            schemaVersion?: unknown;
            deletionId?: unknown;
            owner?: { id?: unknown };
            status?: unknown;
          };
          if (
            journal.schemaVersion !== "pragma.storage-deletion/v1" ||
            journal.deletionId !== record.deletionId ||
            journal.owner?.id !== record.missionId
          )
            throw new Error("Mission deletion transaction mismatch.");
          if (journal.status !== "trashed") {
            await recoverRuntimeSessionDeletion(options.paths, record.deletionId);
            journal = JSON.parse(
              await readFile(
                join(options.paths.deletionJournalRoot(), `${record.deletionId}.json`),
                "utf8",
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
    trackSettlement(id: string, promise: Promise<void>) {
      settlements.set(id, promise);
      void promise.catch(() => undefined);
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
          const existing = await read(input.missionId);
          if (existing !== undefined) return existing;
          const step = () => ({ done: false, attempts: 0, nextAt: 0 });
          const record = MissionDeletionRecordSchema.parse({
            schemaVersion: "pragma.mission-deletion/v1",
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
