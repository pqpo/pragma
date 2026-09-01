import { isHumanInteractionCheckpointError, type PragmaLogger } from "@pragma/core";

import type { MissionStore } from "./mission-store.ts";

export interface MissionExecutionTerminalOutcome {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * Owns the transition from a live Core execution to Desktop Mission metadata.
 * A human checkpoint intentionally settles the in-memory observer without
 * writing a terminal status.
 */
export function observeMissionExecution(
  missions: MissionStore,
  missionId: string,
  execution: {
    readonly executionId: string;
    readonly result: Promise<unknown>;
    readonly getState: () => Promise<{ readonly status: string }>;
  },
  startedAt: string,
  inputMessageId: string,
  onFinished: () => void | Promise<void>,
  sessionId?: string,
  logger?: PragmaLogger,
  onTerminal?: ((input: MissionExecutionTerminalOutcome) => void | Promise<void>) | undefined,
  checkpoint?: Promise<void> | undefined,
): Promise<"terminal" | "checkpointed"> {
  return (async () => {
    let status: MissionExecutionTerminalOutcome["status"] = "succeeded";
    let failure: unknown;
    let result: unknown;
    let checkpointed = false;
    try {
      if (checkpoint === undefined) {
        result = await execution.result;
      } else {
        const outcome = await Promise.race([
          execution.result.then(
            (value) => ({ kind: "completed" as const, value }),
            (error: unknown) => ({ kind: "failed" as const, error }),
          ),
          checkpoint.then(() => ({ kind: "checkpointed" as const })),
        ]);
        if (outcome.kind === "checkpointed") checkpointed = true;
        else if (outcome.kind === "failed") throw outcome.error;
        else result = outcome.value;
      }
    } catch (error) {
      if (isHumanInteractionCheckpointError(error)) {
        checkpointed = true;
      } else {
        const state = await execution.getState().catch(() => undefined);
        status =
          state?.status === "cancelled" || state?.status === "interrupted" ? "cancelled" : "failed";
        failure = error;
      }
    }
    try {
      await onFinished();
    } catch (error) {
      logger?.error(
        "mission.finish_callback_failed",
        `Failed to finish Mission execution ${execution.executionId}.`,
        error,
        { missionId, executionId: execution.executionId },
      );
    }
    if (checkpointed) return "checkpointed";
    try {
      await onTerminal?.({
        status,
        ...(result === undefined ? {} : { result }),
        ...(failure === undefined ? {} : { error: failure }),
      });
    } catch (error) {
      logger?.error(
        "mission.terminal_callback_failed",
        `Failed to project Mission execution ${execution.executionId}.`,
        error,
        { missionId, executionId: execution.executionId },
      );
    }
    await missions.updateExecution(
      missionId,
      {
        id: execution.executionId,
        inputMessageId,
        ...(sessionId === undefined ? {} : { sessionId }),
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(status === "failed"
          ? { error: failure instanceof Error ? failure.message : String(failure) }
          : {}),
      },
      { executionId: execution.executionId, statuses: ["queued", "running", "waiting"] },
    );
    return "terminal";
  })();
}
