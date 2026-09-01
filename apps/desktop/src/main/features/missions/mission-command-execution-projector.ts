import { JsonValueSchema } from "@pragma/shared";
import { createIntegrationError } from "@pragma/shared/integration";
import type { MissionControllerStore, MissionOwnerScope } from "@pragma/local-host";

import type { Mission } from "../../../shared/contracts/index.ts";

export interface MissionCommandExecutionProjector {
  link(mission: Mission, executionId: string): Promise<void>;
  terminal(input: {
    readonly mission: Mission;
    readonly executionId: string;
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly result?: unknown;
    readonly error?: unknown;
  }): Promise<void>;
}

/** Projects follow-up command executions into the same canonical feed as an initial run. */
export function createMissionCommandExecutionProjector(options: {
  readonly controller: MissionControllerStore;
  readonly ownerScope: Pick<MissionOwnerScope, "currentGuard">;
}): MissionCommandExecutionProjector {
  const commandExecutionIds = new Set<string>();

  const append = async (
    missionId: string,
    executionId: string,
    type: "run.started" | "run.succeeded" | "run.failed" | "run.interrupted",
    data: Record<string, unknown>,
  ): Promise<void> => {
    const guard = options.ownerScope.currentGuard(missionId);
    if (guard === undefined) return;
    const snapshot = await options.controller.readSnapshot({ missionId });
    if (
      snapshot.events.some(
        (event) => event.type === type && event.data["executionId"] === executionId,
      )
    ) {
      return;
    }
    await options.controller.write({
      missionId,
      guard,
      operation: async ({ appendEvent }) => {
        await appendEvent(type, { executionId, ...data });
      },
    });
  };

  return {
    async link(mission, executionId) {
      const inputMessageId = mission.execution?.inputMessageId;
      if (inputMessageId === undefined) return;
      const operation = await options.controller.getOperation({
        missionId: mission.id,
        requestId: inputMessageId,
      });
      if (operation?.kind !== "send" && operation?.kind !== "steer") return;
      commandExecutionIds.add(executionId);
      await append(mission.id, executionId, "run.started", {});
    },
    async terminal({ mission, executionId, status, result, error }) {
      if (!commandExecutionIds.has(executionId)) return;
      if (status === "succeeded") {
        const parsedResult = JsonValueSchema.safeParse(result);
        await append(mission.id, executionId, "run.succeeded", {
          result: parsedResult.success ? parsedResult.data : null,
        });
        commandExecutionIds.delete(executionId);
        return;
      }
      if (status === "cancelled") {
        await append(mission.id, executionId, "run.interrupted", {});
        commandExecutionIds.delete(executionId);
        return;
      }
      await append(mission.id, executionId, "run.failed", {
        error: createIntegrationError({
          code: "EXECUTION_FAILED",
          category: "execution",
          retryable: true,
          message: error instanceof Error ? error.message : String(error ?? "Execution failed"),
          details: { missionId: mission.id, executionId },
        }),
      });
      commandExecutionIds.delete(executionId);
    },
  };
}
