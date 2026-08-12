import type { MissionChatUpdate, MissionWorkUpdate } from "../../../shared/contracts/index.ts";
import type { MissionChatNotification, MissionWorkNotification } from "./mission-runner.ts";

export interface MissionRendererUpdateSender {
  send(
    channel: "missions:chat:updated" | "missions:work:updated",
    update: MissionChatUpdate | MissionWorkUpdate,
  ): void;
}

export function forwardMissionChatNotification(options: {
  readonly notification: MissionChatNotification;
  readonly getSender: () => MissionRendererUpdateSender | null;
  readonly refreshMissionSummary: (missionId: string) => Promise<void>;
  readonly reportSummaryRefreshFailure: (error: unknown, missionId: string) => void;
}): void {
  const { audience, update } = options.notification;
  if (audience !== "user") return;
  options.getSender()?.send("missions:chat:updated", update);
  if (update.kind !== "invalidate") return;
  void options
    .refreshMissionSummary(update.missionId)
    .catch((error: unknown) => options.reportSummaryRefreshFailure(error, update.missionId));
}

export function forwardMissionWorkNotification(options: {
  readonly notification: MissionWorkNotification;
  readonly getSender: () => MissionRendererUpdateSender | null;
}): void {
  const { audience, update } = options.notification;
  if (audience !== "user") return;
  options.getSender()?.send("missions:work:updated", update);
}
