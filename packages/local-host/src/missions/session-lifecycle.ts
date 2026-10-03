import {
  ExpertSessionReleaseBlockedError,
  hasUncertainSteerDelivery,
  type ExpertDefinition,
  type ExpertSession,
  type PragmaApp,
} from "@pragma/core";

type ExpertApplication = PragmaApp["experts"];
export type LocalHostSessionOpenRequest =
  | { readonly kind: "create"; readonly options: Parameters<ExpertApplication["createSession"]>[1] }
  | { readonly kind: "resume"; readonly options: Parameters<ExpertApplication["resumeSession"]>[1] }
  | {
      readonly kind: "recover-closed";
      readonly options: Parameters<ExpertApplication["recoverClosedSession"]>[1];
    };

/** All Host surfaces enter Core Session creation and recovery through this boundary. */
export async function openLocalHostExpertSession(
  app: PragmaApp,
  definition: ExpertDefinition,
  request: LocalHostSessionOpenRequest,
): Promise<ExpertSession> {
  switch (request.kind) {
    case "create":
      return await app.experts.createSession(definition, request.options);
    case "resume":
      return await app.experts.resumeSession(definition, request.options);
    case "recover-closed":
      return await app.experts.recoverClosedSession(definition, request.options);
  }
}

/** Durable terminal, human checkpoint and Runtime release remain separate boundaries. */
export async function releaseLocalHostExpertSession(
  session: ExpertSession,
  boundary: "idle" | "terminal" | "checkpoint" = "idle",
  options?: Parameters<ExpertSession["releaseAfterTerminal"]>[0],
): Promise<void> {
  if (boundary === "terminal") return await session.releaseAfterTerminal(options);
  if (boundary === "checkpoint") return await session.releaseAfterHumanCheckpoint();
  let boundaryRechecks = 0;
  for (;;) {
    if ((await session.waitForPromptProcessing()) === "lease-lost") {
      await session.releaseAfterTerminal();
      return;
    }
    const [state, prompts] = await Promise.all([session.getState(), session.getPromptQueue()]);
    const pending = prompts.filter(
      (prompt) =>
        prompt.mode === "enqueue" && (prompt.status === "queued" || prompt.status === "running"),
    );
    const checkpointed =
      state.activeExecutionId === undefined &&
      (state.lastStatus === "waiting" ||
        (state.lastStatus === "failed" && pending.length > 0) ||
        pending.some((prompt) => prompt.purpose === "human_checkpoint_recovery") ||
        hasUncertainSteerDelivery(prompts));
    try {
      if (checkpointed) await session.releaseAfterHumanCheckpoint();
      else await session.releaseAfterTerminal();
      return;
    } catch (error) {
      if (
        error instanceof ExpertSessionReleaseBlockedError &&
        (checkpointed || error.retryable) &&
        boundaryRechecks++ < 3
      )
        continue;
      throw error;
    }
  }
}
