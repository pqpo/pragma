import {
  SteerNotDispatchedError,
  type ExpertSession,
  type ExpertTurn,
  type PromptOptions,
} from "@pragma/core";
import type { ExpertPromptAttachment } from "@pragma/shared";
import { createIntegrationError } from "@pragma/shared/integration";

import { MissionSemanticWritePendingError } from "./controller/mission-controller-store.ts";

export interface MissionExpertPromptSubmission {
  readonly missionId: string;
  readonly session: ExpertSession;
  readonly content: string;
  readonly options: Omit<PromptOptions, "steerFallback"> & { readonly requestId: string };
  /** An already-persisted input, including the initial Mission message. */
  readonly attachmentMessageId?: string | undefined;
  readonly requestedAt?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type MissionPromptAttachmentPreparation = (
  input: Omit<MissionExpertPromptSubmission, "session" | "signal">,
) => Promise<{
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly durable: boolean;
}>;

export function assertMissionPromptContent(content: string): void {
  if (content.trim() === "") throw new Error("Prompt content must not be empty.");
}

export function assertMissionPromptNotCancelled(input: {
  readonly missionId: string;
  readonly requestId: string;
  readonly signal?: AbortSignal | undefined;
}): void {
  if (!input.signal?.aborted) return;
  throw createIntegrationError({
    code: "COMMAND_RESULT_TIMEOUT",
    category: "conflict",
    message: "Mission command application was cancelled before Core acceptance.",
    details: { missionId: input.missionId, requestId: input.requestId },
  });
}

/** One preparation and Core submission boundary for initial and subsequent prompts. */
export async function submitMissionExpertPrompt(
  input: MissionExpertPromptSubmission,
  prepareAttachments?: MissionPromptAttachmentPreparation,
): Promise<{ readonly turn: ExpertTurn; readonly attachments: readonly ExpertPromptAttachment[] }> {
  assertMissionPromptContent(input.content);
  const cancellation = {
    missionId: input.missionId,
    requestId: input.options.requestId,
    signal: input.signal,
  };
  assertMissionPromptNotCancelled(cancellation);
  // Core rejects attachment-bearing strict steer before recording or dispatching it.
  // Its rejection must not create a durable Mission message.
  const prepared =
    (input.options.mode ?? "enqueue") === "enqueue"
      ? await prepareAttachments?.({
          missionId: input.missionId,
          content: input.content,
          options: input.options,
          attachmentMessageId: input.attachmentMessageId,
          requestedAt: input.requestedAt,
        })
      : undefined;
  const attachments = prepared?.attachments ?? input.options.attachments ?? [];
  // Attachment I/O may outlive the controller deadline. Keep its durable intent
  // for replay, but do not submit from this cancelled attempt.
  assertMissionPromptNotCancelled(cancellation);
  const promptOptions = { ...input.options };
  if (attachments.length === 0) delete promptOptions.attachments;
  else promptOptions.attachments = attachments;
  const turn = await input.session.prompt(input.content, promptOptions).catch((error: unknown) => {
    if (
      input.options.mode === "steer" &&
      error instanceof SteerNotDispatchedError &&
      error.reason === "target_changed"
    ) {
      throw createIntegrationError({
        code: "STEER_TARGET_CHANGED",
        category: "conflict",
        message: "Strict Mission steer target changed before native dispatch.",
        details: { missionId: input.missionId },
      });
    }
    if (prepared?.durable === true) {
      throw new MissionSemanticWritePendingError({ cause: error });
    }
    throw error;
  });
  return { turn, attachments };
}
