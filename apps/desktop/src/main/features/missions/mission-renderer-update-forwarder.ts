import type { MissionChatUpdate, MissionWorkUpdate } from "../../../shared/contracts/index.ts";
import type { MissionChatNotification, MissionWorkNotification } from "./mission-runner.ts";

export interface MissionRendererUpdateSender {
  send(
    channel: "missions:chat:updated" | "missions:work:updated",
    update: MissionChatUpdate | MissionWorkUpdate,
  ): void;
}

/**
 * Serialize summary reads for each Mission. Chat invalidations can arrive in quick succession,
 * and sending a slower, older read after a newer one would regress the Mission rail.
 */
export function createMissionSummaryRefreshScheduler(
  refresh: (missionId: string) => Promise<void>,
): (missionId: string) => Promise<void> {
  const tails = new Map<string, Promise<void>>();

  return (missionId) => {
    const previous = tails.get(missionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => await refresh(missionId));
    tails.set(missionId, next);
    void next.then(
      () => {
        if (tails.get(missionId) === next) tails.delete(missionId);
      },
      () => {
        if (tails.get(missionId) === next) tails.delete(missionId);
      },
    );
    return next;
  };
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
