import type { ExpertSessionEvent, PromptRequest, MissionConversationState } from "@pragma/shared";

/** Project delivery facts from one Session snapshot for both history and controls. */
export function projectMissionPromptDeliveries(
  promptQueue: readonly PromptRequest[],
  sessionEvents: readonly ExpertSessionEvent[],
): Pick<MissionConversationState, "deliveries" | "hiddenEntryIds"> {
  const removedPromptIds = new Set(
    sessionEvents.flatMap((event) => {
      if (event.type !== "prompt.removed") return [];
      const requestId = (event.data as { requestId?: unknown }).requestId;
      return typeof requestId === "string" ? [requestId] : [];
    }),
  );
  const steerFallbackByRequestId = new Map<string, string>();
  for (const event of sessionEvents) {
    if (event.type !== "prompt.steer-fallback") continue;
    const data = event.data as { requestId?: unknown; reason?: unknown };
    if (typeof data.requestId === "string" && typeof data.reason === "string") {
      steerFallbackByRequestId.set(data.requestId, data.reason);
    }
  }
  const executionActivatedAt = new Map<string, string>();
  for (const event of sessionEvents) {
    if (event.type !== "execution.attached") continue;
    const executionId = (event.data as { executionId?: unknown }).executionId;
    if (typeof executionId === "string") executionActivatedAt.set(executionId, event.occurredAt);
  }
  const deliveries = promptQueue.flatMap((prompt) => {
    const fallbackReason = steerFallbackByRequestId.get(prompt.requestId);
    const queueSteered =
      prompt.deliveryAttempt?.kind === "queue_steer" &&
      prompt.deliveryAttempt.state === "confirmed";
    const activatedAt = queueSteered
      ? prompt.updatedAt
      : prompt.mode === "enqueue" && prompt.status !== "queued"
        ? executionActivatedAt.get(prompt.executionId)
        : undefined;
    return [
      {
        entryId: prompt.requestId,
        delivery: {
          requestedMode: queueSteered || fallbackReason !== undefined ? "steer" : prompt.mode,
          effectiveMode: queueSteered ? "steer" : prompt.mode,
          status: prompt.status,
          ...(activatedAt === undefined ? {} : { activatedAt }),
          ...(removedPromptIds.has(prompt.requestId) ? { removed: true } : {}),
          ...(fallbackReason === undefined ? {} : { fallbackReason }),
        },
      },
    ];
  });
  const hiddenEntryIds = promptQueue.flatMap((prompt) =>
    prompt.deliveryAttempt?.kind === "queue_steer" &&
    prompt.deliveryAttempt.state === "confirmed" &&
    prompt.deliveryAttempt.sourceExecutionId !== undefined
      ? [`result:${prompt.deliveryAttempt.sourceExecutionId}`]
      : [],
  );
  return { deliveries, hiddenEntryIds };
}
