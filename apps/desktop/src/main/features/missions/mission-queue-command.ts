import type { MissionQueuePromptAction } from "../../../shared/contracts/index.ts";

export function toMissionQueueCommand(
  input: MissionQueuePromptAction,
  kind: "queue.remove" | "queue.steer",
) {
  return {
    missionId: input.id,
    requestId: input.requestId,
    kind,
    payload: { kind, requestId: input.queueItemRequestId },
    target: { queueItemId: input.queueItemRequestId },
  } as const;
}
