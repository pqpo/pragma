import type {
  MissionChatUpdate,
  MissionStatusUpdate,
  MissionWorkUpdate,
} from "../../../shared/contracts/index.ts";
import type { MissionChatNotification, MissionWorkNotification } from "./mission-runner.ts";
import type { MissionStatusNotification } from "./mission-status-service.ts";

export interface MissionRendererUpdateSender {
  send(
    channel: "missions:chat:updated" | "missions:status:updated" | "missions:work:updated",
    update: MissionChatUpdate | MissionStatusUpdate | MissionWorkUpdate,
  ): void;
}

export function forwardMissionChatNotification(options: {
  readonly notification: MissionChatNotification;
  readonly getSender: () => MissionRendererUpdateSender | null;
}): void {
  const { audience, update } = options.notification;
  if (audience !== "user") return;
  options.getSender()?.send("missions:chat:updated", update);
}

export function forwardMissionStatusNotification(options: {
  readonly notification: MissionStatusNotification;
  readonly getSender: () => MissionRendererUpdateSender | null;
}): void {
  if (options.notification.audience !== "user") return;
  const { missionId, revision, execution } = options.notification;
  options.getSender()?.send("missions:status:updated", {
    missionId,
    revision,
    ...(execution === undefined ? {} : { execution }),
  });
}

export function forwardMissionWorkNotification(options: {
  readonly notification: MissionWorkNotification;
  readonly getSender: () => MissionRendererUpdateSender | null;
}): void {
  const { audience, update } = options.notification;
  if (audience !== "user") return;
  options.getSender()?.send("missions:work:updated", update);
}
