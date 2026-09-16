import type { ExecutionStore } from "@pragma/core";
import type { MissionQueryPort } from "@pragma/local-host";
import type { MissionSummary as LocalHostMissionSummary } from "@pragma/shared/integration";

import type { Mission, MissionSummary } from "../../../shared/contracts/index.ts";
import type { MissionStore } from "./mission-store.ts";

type MissionExecutionStatus = NonNullable<Mission["execution"]>["status"];

export interface MissionProjectionMismatch {
  readonly mission: Mission;
  readonly executionId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly finishedAt: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * Composes Desktop-owned Mission metadata with the Local Host/Core execution
 * facts. Persisted Mission execution fields remain recovery links; their
 * mutable status is never preferred over a newer canonical terminal state.
 */
export function createMissionReadModel(options: {
  readonly missions: Pick<MissionStore, "get" | "list">;
  readonly queryMission: MissionQueryPort["queryMission"];
  readonly executions: Pick<ExecutionStore, "get">;
  readonly onProjectionMismatch?:
    ((input: MissionProjectionMismatch) => void | Promise<void>) | undefined;
  readonly onReadFailure?:
    ((input: { readonly missionId: string; readonly error: unknown }) => void) | undefined;
}): Pick<MissionStore, "get" | "list"> {
  const repairs = new Map<string, Promise<void>>();

  const readProjection = async (
    missionId: string,
    persistedExecution?:
      | {
          readonly id: string;
          readonly status: MissionExecutionStatus;
        }
      | undefined,
  ): Promise<{
    readonly summary?: LocalHostMissionSummary | undefined;
    readonly executionId?: string | undefined;
    readonly status?: MissionExecutionStatus | undefined;
    readonly error?: string | undefined;
    readonly finishedAt?: string | undefined;
    readonly mismatch?: Omit<MissionProjectionMismatch, "mission"> | undefined;
  }> => {
    let summary: LocalHostMissionSummary | undefined;
    try {
      const queried = await options.queryMission({
        missionId,
        view: "summary",
        limit: 1,
      });
      if (queried.schemaVersion === "pragma.mission-summary/v1") summary = queried;
    } catch (error) {
      options.onReadFailure?.({ missionId, error });
    }
    const executionId = persistedExecution?.id ?? summary?.execution?.id;
    const execution =
      executionId === undefined
        ? undefined
        : await options.executions.get(executionId).catch((error: unknown) => {
            options.onReadFailure?.({ missionId, error });
            return undefined;
          });
    const canonicalStatus = execution?.status;
    const terminalStatus =
      canonicalStatus === "succeeded" ||
      canonicalStatus === "failed" ||
      canonicalStatus === "cancelled" ||
      canonicalStatus === "interrupted"
        ? canonicalStatus === "interrupted"
          ? ("cancelled" as const)
          : canonicalStatus
        : undefined;
    const projectedExecution = summary?.execution;
    const projectedStatus =
      projectedExecution !== undefined && projectedExecution.id === executionId
        ? normalizeStatus(projectedExecution.status)
        : undefined;
    const status = terminalStatus ?? projectedStatus;
    const mismatch =
      executionId !== undefined &&
      terminalStatus !== undefined &&
      (terminalStatus !== projectedStatus || terminalStatus !== persistedExecution?.status)
        ? {
            executionId,
            status: terminalStatus,
            finishedAt: execution!.updatedAt,
            ...(execution?.output === undefined
              ? {}
              : {
                  result:
                    execution.output.type === "inline" ? execution.output.value : execution.output,
                }),
            ...(execution?.error === undefined ? {} : { error: execution.error }),
          }
        : undefined;
    return {
      summary,
      executionId,
      status,
      ...(execution?.error === undefined ? {} : { error: errorMessage(execution.error) }),
      ...(terminalStatus === undefined || execution === undefined
        ? {}
        : { finishedAt: execution.updatedAt }),
      mismatch,
    };
  };

  const scheduleRepair = (mismatch: MissionProjectionMismatch): void => {
    if (options.onProjectionMismatch === undefined || repairs.has(mismatch.mission.id)) return;
    const repair = Promise.resolve(options.onProjectionMismatch(mismatch))
      .catch((error: unknown) => {
        options.onReadFailure?.({ missionId: mismatch.mission.id, error });
      })
      .finally(() => {
        if (repairs.get(mismatch.mission.id) === repair) repairs.delete(mismatch.mission.id);
      });
    repairs.set(mismatch.mission.id, repair);
  };

  const projectMission = async (mission: Mission): Promise<Mission> => {
    if (mission.execution === undefined) return mission;
    const projection = await readProjection(mission.id, mission.execution);
    if (
      mission.execution === undefined ||
      projection.executionId !== mission.execution.id ||
      projection.status === undefined
    ) {
      return mission;
    }
    if (projection.mismatch !== undefined) {
      scheduleRepair({ ...projection.mismatch, mission });
    }
    const executionWithoutError = {
      id: mission.execution.id,
      inputMessageId: mission.execution.inputMessageId,
      ...(mission.execution.sessionId === undefined
        ? {}
        : { sessionId: mission.execution.sessionId }),
      ...(mission.execution.waitReason === undefined
        ? {}
        : { waitReason: mission.execution.waitReason }),
      ...(mission.execution.contextMountsFingerprint === undefined
        ? {}
        : { contextMountsFingerprint: mission.execution.contextMountsFingerprint }),
      startedAt: mission.execution.startedAt,
      ...(mission.execution.finishedAt === undefined
        ? {}
        : { finishedAt: mission.execution.finishedAt }),
    };
    return {
      ...mission,
      execution: {
        ...executionWithoutError,
        status: projection.status,
        ...(projection.finishedAt === undefined ? {} : { finishedAt: projection.finishedAt }),
        ...(projection.status === "failed" && projection.error !== undefined
          ? { error: projection.error }
          : {}),
      },
      updatedAt:
        projection.summary === undefined
          ? mission.updatedAt
          : latestTimestamp(mission.updatedAt, projection.summary.updatedAt),
    };
  };

  return {
    async get(id) {
      return await projectMission(await options.missions.get(id));
    },
    async list() {
      return await mapWithConcurrency(
        await options.missions.list(),
        8,
        async (summary): Promise<MissionSummary> => {
          // Terminal snapshots cannot regress. Only active snapshots need the
          // more expensive Local Host/Core reconciliation that repairs this
          // class of stale-status bug.
          if (!isActiveExecutionStatus(summary.execution?.status)) return summary;
          const mission = await options.missions.get(summary.id);
          if (mission.execution === undefined) return summary;
          const projection = await readProjection(summary.id, mission.execution);
          if (projection.mismatch !== undefined) {
            scheduleRepair({ ...projection.mismatch, mission });
          }
          if (projection.status === undefined) return summary;
          return {
            ...summary,
            execution: {
              status: projection.status,
              ...(projection.status === "waiting" && summary.execution?.waitReason !== undefined
                ? { waitReason: summary.execution.waitReason }
                : {}),
            },
            updatedAt:
              projection.summary === undefined
                ? summary.updatedAt
                : latestTimestamp(summary.updatedAt, projection.summary.updatedAt),
          };
        },
      );
    },
  };
}

function normalizeStatus(
  status: MissionExecutionStatus | "interrupted" | undefined,
): MissionExecutionStatus | undefined {
  return status === "interrupted" ? "cancelled" : status;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function latestTimestamp(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function isActiveExecutionStatus(status: MissionExecutionStatus | undefined): boolean {
  return status === "queued" || status === "running" || status === "waiting";
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  project: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await project(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
