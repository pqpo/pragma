import { isHumanInteractionCheckpointError } from "@pragma/core";

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
  onTerminal?: ((input: MissionExecutionTerminalOutcome) => void | Promise<void>) | undefined,
  checkpoint?: Promise<void> | undefined,
  onMaterialize?: ((input: MissionExecutionTerminalOutcome) => void | Promise<void>) | undefined,
  onSideEffectError?: ((error: unknown) => void) | undefined,
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
    if (checkpointed) {
      await onFinished();
      return "checkpointed";
    }
    // The Core result is the terminal fact. Project it into the canonical
    // Mission event feed first; the v10 Mission snapshot and cleanup are
    // independent recovery projections and cannot roll it back.
    const terminal = {
      status,
      ...(result === undefined ? {} : { result }),
      ...(failure === undefined ? {} : { error: failure }),
    } satisfies MissionExecutionTerminalOutcome;
    for (const sideEffect of [
      async () => await onTerminal?.(terminal),
      async () =>
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
        ),
      onFinished,
      async () => await onMaterialize?.(terminal),
    ]) {
      try {
        await sideEffect();
      } catch (error) {
        try {
          onSideEffectError?.(error);
        } catch {
          // Error reporting is also a side effect and cannot roll back a
          // terminal status that has already committed.
        }
      }
    }
    return "terminal";
  })();
}
