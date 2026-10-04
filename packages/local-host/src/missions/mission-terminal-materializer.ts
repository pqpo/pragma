import type { DurableExecutionStore } from "@pragma/core";
import type { Mission } from "@pragma/shared";
import type { MissionOwnerScope } from "./controller/owner-scope.ts";
import type { MissionStore } from "./repository/mission-store.ts";
import type { MissionExecutionEventProjector } from "./mission-execution-event-projector.ts";
import { persistMissionExecutionProjection } from "./execution-service.ts";
import type { MissionDeliveryStep } from "./mission-delivery.ts";

/** Product projection follows durable facts; archive cannot overtake history custody. */
export function createMissionTerminalMaterializer(input: {
  readonly ownerScope: MissionOwnerScope;
  readonly missions: MissionStore;
  readonly executions: DurableExecutionStore;
  readonly projector: MissionExecutionEventProjector;
  readonly ownerLifetime?: "host" | "request";
  readonly withAdmission?:
    | ((
        missionId: string,
        operation: () => Promise<void | "deferred">,
      ) => Promise<void | "deferred">)
    | undefined;
  readonly memory: (mission: Mission, executionId: string) => Promise<void>;
  readonly onProjectionChanged?: ((missionId: string) => void) | undefined;
}) {
  return async (
    registered: Mission,
    executionId: string,
    requestId: string,
    status: "succeeded" | "failed" | "cancelled",
    step: MissionDeliveryStep,
  ): Promise<void | "deferred"> => {
    const materialize = async (): Promise<void | "deferred"> => {
      const existingGuard = input.ownerScope.currentGuard(registered.id);
      // A one-shot request must not rebuild its released owner for product enrichment.
      // The durable receipt remains available to the next explicit access or host consumer.
      if (input.ownerLifetime === "request" && existingGuard === undefined) return "deferred";
      const guard = await input.ownerScope.acquire(registered.id);
      await input.ownerScope.runWithGuard(registered.id, guard, async () => {
        const mission = await input.missions.get(registered.id);
        const execution = await input.executions.get(executionId);
        if (execution === undefined) throw new Error("MISSION_DELIVERY_EXECUTION_UNAVAILABLE");
        const failure =
          typeof execution.error === "object" &&
          execution.error !== null &&
          "message" in execution.error &&
          typeof execution.error.message === "string"
            ? execution.error.message
            : String(execution.error ?? "Execution failed");
        if (step === "terminal") {
          await input.projector.terminal({
            mission,
            executionId,
            status,
            result: execution.output?.type === "inline" ? execution.output.value : execution.output,
            error: status === "failed" ? new Error(failure) : execution.error,
            guard,
          });
        } else if (step === "metadata") {
          await input.missions.updateExecution(
            mission.id,
            {
              id: executionId,
              inputMessageId: requestId,
              ...(mission.execution?.id === executionId && mission.execution.sessionId !== undefined
                ? { sessionId: mission.execution.sessionId }
                : {}),
              status,
              startedAt: execution.createdAt,
              finishedAt: execution.updatedAt,
              ...(status === "failed" ? { error: failure } : {}),
            },
            { executionId, statuses: ["queued", "running", "waiting"] },
          );
        } else if (step === "memory") {
          await input.memory(mission, executionId);
        } else if (step === "history") {
          const projection = await persistMissionExecutionProjection(
            input.missions,
            input.executions,
            mission.id,
            executionId,
            status === "cancelled",
          );
          if (projection.status !== "current") throw new Error("MISSION_CHAT_PROJECTION_PARTIAL");
          input.onProjectionChanged?.(mission.id);
        } else {
          await input.executions.archive(executionId);
        }
      });
    };
    if (input.ownerLifetime === "request") {
      if (input.withAdmission === undefined)
        throw new Error("MISSION_DELIVERY_ADMISSION_UNAVAILABLE");
      return await input.ownerScope.runWithoutGuard(
        async () => await input.withAdmission!(registered.id, materialize),
      );
    } else return await input.ownerScope.runWithoutGuard(materialize);
  };
}
