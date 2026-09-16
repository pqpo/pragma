import type { MissionOwnerScope } from "@pragma/local-host";

import type { Mission } from "../../../shared/contracts/index.ts";
import type { MissionExecutionEventProjector } from "./mission-command-execution-projector.ts";
import type { MissionProjectionMismatch } from "./mission-read-model.ts";
import type { MissionStatusService } from "./mission-status-service.ts";
import type { MissionStore } from "./mission-store.ts";

interface MissionTerminalProjectionRepairReporter {
  eventFailure(error: unknown, input: MissionProjectionMismatch): void;
  snapshotFailure(error: unknown, input: MissionProjectionMismatch): void;
  rebuilt(input: MissionProjectionMismatch): void;
}

/** Repairs the two durable Mission projections without coupling their failure domains. */
export function createMissionTerminalProjectionRepair(options: {
  readonly ownerScope: Pick<
    MissionOwnerScope,
    "currentGuard" | "acquire" | "runWithGuard" | "release"
  >;
  readonly missions: Pick<MissionStore, "updateExecution">;
  readonly events: Pick<MissionExecutionEventProjector, "terminal">;
  readonly status: MissionStatusService;
  readonly audienceForMission: (mission: Mission) => "user" | "internal";
  readonly reporter: MissionTerminalProjectionRepairReporter;
}): (input: MissionProjectionMismatch) => Promise<void> {
  return async (input) => {
    const existingGuard = options.ownerScope.currentGuard(input.mission.id);
    let acquired = false;
    const failures: unknown[] = [];
    let eventProjectionCurrent = false;
    try {
      const guard = existingGuard ?? (await options.ownerScope.acquire(input.mission.id));
      acquired = existingGuard === undefined;
      await options.ownerScope.runWithGuard(input.mission.id, guard, async () => {
        try {
          await retryRepair(async () => {
            await options.events.terminal({
              mission: input.mission,
              executionId: input.executionId,
              status: input.status,
              ...(input.result === undefined ? {} : { result: input.result }),
              ...(input.error === undefined ? {} : { error: input.error }),
            });
          });
          eventProjectionCurrent = true;
        } catch (error) {
          failures.push(error);
          options.reporter.eventFailure(error, input);
        }

        const persistedExecution = input.mission.execution;
        if (persistedExecution?.id === input.executionId) {
          try {
            await retryRepair(async () => {
              await options.missions.updateExecution(
                input.mission.id,
                {
                  ...persistedExecution,
                  status: input.status,
                  finishedAt: input.finishedAt,
                  ...(input.status === "failed"
                    ? { error: terminalErrorMessage(input.error) }
                    : {}),
                },
                {
                  executionId: input.executionId,
                  statuses: ["queued", "running", "waiting"],
                },
              );
            });
          } catch (error) {
            failures.push(error);
            options.reporter.snapshotFailure(error, input);
          }
        }
      });
      if (eventProjectionCurrent) options.reporter.rebuilt(input);
    } finally {
      try {
        if (acquired) await options.ownerScope.release(input.mission.id);
      } finally {
        options.status.publish(input.mission.id, options.audienceForMission(input.mission), {
          id: input.executionId,
          status: input.status,
        });
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Mission terminal projection repair remained degraded.");
    }
  };
}

async function retryRepair(operation: () => Promise<void>): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

function terminalErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Execution failed";
}
