import { isHumanInteractionCheckpointError } from "@pragma/core";

import type { MissionStore } from "./repository/mission-store.ts";

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
  deferMaterialization = false,
  boundaries?: {
    readonly onDurableTerminal?: (error?: unknown) => void;
    readonly deferEnrichment?: boolean;
  },
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
    const necessary = [
      async () => await onTerminal?.(terminal),
      async () => {
        if (deferMaterialization && status !== "cancelled") return;
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
      },
    ];
    let commitFailure: unknown;
    const runSideEffect = async (sideEffect: () => void | Promise<void>): Promise<void> => {
      try {
        await sideEffect();
      } catch (error) {
        try {
          onSideEffectError?.(error);
        } catch {
          /* Diagnostics never change the durable fact. */
        }
        throw error;
      }
    };
    for (const sideEffect of necessary) {
      try {
        await runSideEffect(sideEffect);
      } catch (error) {
        commitFailure ??= error;
      }
    }
    boundaries?.onDurableTerminal?.(commitFailure);
    for (const sideEffect of [
      onFinished,
      async () => {
        if (!boundaries?.deferEnrichment && (!deferMaterialization || status === "cancelled"))
          await onMaterialize?.(terminal);
      },
    ]) {
      try {
        await runSideEffect(sideEffect);
      } catch {
        /* Recovery projections remain replayable. */
      }
    }
    return "terminal";
  })();
}
