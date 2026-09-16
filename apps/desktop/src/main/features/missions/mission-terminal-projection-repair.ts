import { randomUUID } from "node:crypto";

import type { MissionControllerStore, MissionOwnerScope } from "@pragma/local-host";

import type { Mission } from "../../../shared/contracts/index.ts";
import type { MissionExecutionEventProjector } from "./mission-command-execution-projector.ts";
import type { MissionStore } from "./mission-store.ts";

interface MissionTerminalProjectionRepairReporter {
  eventFailure(error: unknown, input: MissionProjectionMismatch): void;
  snapshotFailure(error: unknown, input: MissionProjectionMismatch): void;
  rebuilt(input: MissionProjectionMismatch): void;
}

export interface MissionProjectionMismatch {
  readonly mission: Mission;
  readonly executionId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly finishedAt: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Repairs the two durable Mission projections without coupling their failure domains. */
export function createMissionTerminalProjectionRepair(options: {
  readonly ownerScope: Pick<MissionOwnerScope, "runWithGuard">;
  readonly controller: Pick<MissionControllerStore, "claim" | "release">;
  readonly missions: Pick<MissionStore, "updateExecution">;
  readonly events: Pick<MissionExecutionEventProjector, "terminal">;
  readonly reporter: MissionTerminalProjectionRepairReporter;
}): (input: MissionProjectionMismatch) => Promise<void> {
  return async (input) => {
    const repairClaimId = randomUUID();
    const guard = await options.controller.claim({
      missionId: input.mission.id,
      claimId: repairClaimId,
      leaseMs: 30_000,
    });
    const failures: unknown[] = [];
    let eventProjectionCurrent = false;
    try {
      await options.ownerScope.runWithGuard(input.mission.id, guard, async () => {
        try {
          await retryRepair(async () => {
            await options.events.terminal({
              mission: input.mission,
              executionId: input.executionId,
              status: input.status,
              ...(input.result === undefined ? {} : { result: input.result }),
              ...(input.error === undefined ? {} : { error: input.error }),
              guard,
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
      await options.controller.release({ missionId: input.mission.id, guard });
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
