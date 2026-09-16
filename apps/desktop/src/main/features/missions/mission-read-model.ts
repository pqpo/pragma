import type { ExecutionStore } from "@pragma/core";

import type { Mission } from "../../../shared/contracts/index.ts";
import type { MissionStore } from "./mission-store.ts";

/**
 * Composes Desktop-owned Mission metadata with the Local Host/Core execution
 * facts. Persisted Mission execution fields remain recovery links; their
 * mutable status is never preferred over a newer canonical terminal state.
 */
export function createMissionReadModel(options: {
  readonly missions: Pick<MissionStore, "get" | "list">;
  readonly executions: Pick<ExecutionStore, "get">;
  readonly onReadFailure?:
    ((input: { readonly missionId: string; readonly error: unknown }) => void) | undefined;
  readonly canonicalReadTimeoutMs?: number | undefined;
}): Pick<MissionStore, "get" | "list"> {
  const readTimeoutMs = options.canonicalReadTimeoutMs ?? 250;

  const projectMission = async (mission: Mission): Promise<Mission> => {
    if (mission.execution === undefined) return mission;
    const execution = await within(
      options.executions.get(mission.execution.id),
      readTimeoutMs,
      `Mission canonical Execution read timed out after ${readTimeoutMs}ms.`,
    ).catch((error: unknown) => {
      options.onReadFailure?.({ missionId: mission.id, error });
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
    if (terminalStatus === undefined || execution === undefined) return mission;
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
        status: terminalStatus,
        finishedAt: execution.updatedAt,
        ...(terminalStatus === "failed" && execution.error !== undefined
          ? { error: errorMessage(execution.error) }
          : {}),
      },
      updatedAt: latestTimestamp(mission.updatedAt, execution.updatedAt),
    };
  };

  return {
    async get(id) {
      return await projectMission(await options.missions.get(id));
    },
    async list() {
      // The rail is availability-critical. Canonical reconciliation is
      // scheduled separately and must never become a list dependency.
      return await options.missions.list();
    },
  };
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

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
