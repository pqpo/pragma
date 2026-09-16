import type { ExecutionStore } from "@pragma/core";

import type { Mission } from "../../../shared/contracts/index.ts";
import type { MissionStatusService } from "./mission-status-service.ts";
import type { MissionStore } from "./mission-store.ts";
import type { MissionProjectionMismatch } from "./mission-terminal-projection-repair.ts";

type TerminalStatus = MissionProjectionMismatch["status"];

/**
 * Reconciles stale terminal projections outside renderer-facing reads.
 * Work is bounded and coalesced per Mission so a damaged aggregate cannot
 * consume the main-process IPC path or starve unrelated resources.
 */
export function createMissionTerminalReconciler(options: {
  readonly missions: Pick<MissionStore, "get">;
  readonly executions: Pick<ExecutionStore, "get">;
  readonly repair: (input: MissionProjectionMismatch) => Promise<void>;
  readonly status: MissionStatusService;
  readonly audienceForMission: (mission: Mission) => "user" | "internal";
  readonly reportFailure: (input: { readonly missionId: string; readonly error: unknown }) => void;
  readonly concurrency?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxPending?: number | undefined;
}): {
  schedule(missionIds: readonly string[]): void;
} {
  const concurrency = options.concurrency ?? 2;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxPending = options.maxPending ?? 256;
  const queued = new Set<string>();
  const pending: string[] = [];
  let active = 0;
  let drainScheduled = false;
  let scheduleOffset = 0;

  const drain = (): void => {
    while (active < concurrency) {
      const missionId = pending.shift();
      if (missionId === undefined) return;
      active += 1;
      const reconciliation = reconcile(missionId);
      void reconciliation.then(
        () => queued.delete(missionId),
        () => queued.delete(missionId),
      );
      void within(
        reconciliation,
        timeoutMs,
        `Mission terminal reconciliation timed out after ${timeoutMs}ms.`,
      )
        .catch((error: unknown) => options.reportFailure({ missionId, error }))
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  const requestDrain = (): void => {
    if (drainScheduled) return;
    drainScheduled = true;
    const handle = setImmediate(() => {
      drainScheduled = false;
      drain();
    });
    handle.unref();
  };

  const reconcile = async (missionId: string): Promise<void> => {
    const mission = await options.missions.get(missionId);
    if (!isActive(mission.execution?.status) || mission.execution === undefined) return;
    const execution = await options.executions.get(mission.execution.id);
    const status = terminalStatus(execution?.status);
    if (status === undefined || execution === undefined) return;

    options.status.publish(mission.id, options.audienceForMission(mission), {
      id: mission.execution.id,
      status,
    });

    await options.repair({
      mission,
      executionId: mission.execution.id,
      status,
      finishedAt: execution.updatedAt,
      ...(execution.output === undefined
        ? {}
        : {
            result: execution.output.type === "inline" ? execution.output.value : execution.output,
          }),
      ...(execution.error === undefined ? {} : { error: execution.error }),
    });
  };

  return {
    schedule(missionIds) {
      const candidates = [...new Set(missionIds)];
      if (candidates.length === 0) return;
      const start = scheduleOffset % candidates.length;
      let visited = 0;
      while (visited < candidates.length && pending.length + active < maxPending) {
        const missionId = candidates[(start + visited) % candidates.length]!;
        visited += 1;
        if (queued.has(missionId)) continue;
        queued.add(missionId);
        pending.push(missionId);
      }
      // Rotate the next scan even when capacity is currently exhausted. A
      // stable list order therefore cannot let repeatedly failing early items
      // starve later Missions forever.
      scheduleOffset = (start + Math.max(visited, 1)) % candidates.length;
      requestDrain();
    },
  };
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

function isActive(status: NonNullable<Mission["execution"]>["status"] | undefined) {
  return status === "queued" || status === "running" || status === "waiting";
}

function terminalStatus(status: string | undefined): TerminalStatus | undefined {
  if (status === "succeeded" || status === "failed" || status === "cancelled") return status;
  return status === "interrupted" ? "cancelled" : undefined;
}
