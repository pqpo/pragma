import { JsonValueSchema } from "@pragma/shared";
import { createIntegrationError } from "@pragma/shared/integration";
import {
  missionRunEventId,
  type MissionControllerGuard,
  type MissionControllerStore,
  type MissionOwnerScope,
} from "@pragma/local-host";

import type { Mission } from "../../../shared/contracts/index.ts";

export interface MissionExecutionEventProjector {
  link(input: {
    readonly mission: Mission;
    readonly executionId: string;
    readonly requestId: string;
  }): Promise<void>;
  terminal(input: {
    readonly mission: Mission;
    readonly executionId: string;
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly result?: unknown;
    readonly error?: unknown;
    readonly guard?: MissionControllerGuard | undefined;
  }): Promise<void>;
}

/** Projects every Desktop execution path into the shared durable Mission event feed. */
export function createMissionExecutionEventProjector(options: {
  readonly controller: MissionControllerStore;
  readonly ownerScope: Pick<MissionOwnerScope, "currentGuard">;
}): MissionExecutionEventProjector {
  const append = async (
    missionId: string,
    executionId: string,
    type: "run.started" | "run.succeeded" | "run.failed" | "run.interrupted",
    data: Record<string, unknown>,
    explicitGuard?: MissionControllerGuard | undefined,
  ): Promise<void> => {
    const guard = explicitGuard ?? options.ownerScope.currentGuard(missionId);
    if (guard === undefined) {
      throw createIntegrationError({
        code: "MISSION_FENCING_REJECTED",
        category: "conflict",
        message: "Mission execution projection requires a live owner.",
        details: { missionId, executionId, eventType: type },
      });
    }
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
        await appendEvent(type, { executionId, ...data }, missionRunEventId(executionId, type));
      },
    });
  };

  return {
    async link({ mission, executionId, requestId }) {
      const operation = await options.controller.getOperation({
        missionId: mission.id,
        requestId,
      });
      if (operation?.kind !== "send" && operation?.kind !== "steer") return;
      await append(mission.id, executionId, "run.started", {});
    },
    async terminal({ mission, executionId, status, result, error, guard }) {
      const snapshot = await options.controller.readSnapshot({ missionId: mission.id });
      const linked = snapshot.events.some(
        (event) =>
          (event.type === "run.started" || event.type === "execution.started") &&
          event.data["executionId"] === executionId,
      );
      // A Core Execution can outlive the Desktop write that originally linked
      // it. Re-establish the missing anchor before its terminal event so the
      // Local Host projection can always recover from that partial commit.
      if (!linked) await append(mission.id, executionId, "run.started", {}, guard);
      if (status === "succeeded") {
        const parsedResult = JsonValueSchema.safeParse(result);
        await append(
          mission.id,
          executionId,
          "run.succeeded",
          {
            result: parsedResult.success ? parsedResult.data : null,
          },
          guard,
        );
        return;
      }
      if (status === "cancelled") {
        await append(mission.id, executionId, "run.interrupted", {}, guard);
        return;
      }
      await append(
        mission.id,
        executionId,
        "run.failed",
        {
          error: createIntegrationError({
            code: "EXECUTION_FAILED",
            category: "execution",
            retryable: true,
            message: error instanceof Error ? error.message : String(error ?? "Execution failed"),
            details: { missionId: mission.id, executionId },
          }),
        },
        guard,
      );
    },
  };
}
