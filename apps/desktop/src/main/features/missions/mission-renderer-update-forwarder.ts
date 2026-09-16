import type {
  Mission,
  MissionChatUpdate,
  MissionWorkUpdate,
} from "../../../shared/contracts/index.ts";
import type { MissionChatNotification, MissionWorkNotification } from "./mission-runner.ts";
import type { MissionStatusNotification } from "./mission-status-service.ts";

export interface MissionRendererUpdateSender {
  send(
    channel: "missions:chat:updated" | "missions:work:updated",
    update: MissionChatUpdate | MissionWorkUpdate,
  ): void;
}

/** Serialize status-driven summary reads per Mission and retry transient storage failures. */
export function createMissionSummaryRefreshScheduler(
  refresh: (notification: MissionStatusNotification) => Promise<void>,
  retryDelaysMs: readonly number[] = [50, 250, 1_000],
): (notification: MissionStatusNotification) => Promise<void> {
  const tails = new Map<string, Promise<void>>();

  return (notification) => {
    const { missionId } = notification;
    const previous = tails.get(missionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => await retryRefresh(notification, refresh, retryDelaysMs));
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
}): void {
  const { audience, update } = options.notification;
  if (audience !== "user") return;
  options.getSender()?.send("missions:chat:updated", update);
}

export function forwardMissionStatusNotification(options: {
  readonly notification: MissionStatusNotification;
  readonly refreshMissionSummary: (notification: MissionStatusNotification) => Promise<void>;
  readonly reportSummaryRefreshFailure: (error: unknown, missionId: string) => void;
}): void {
  if (options.notification.audience !== "user") return;
  const { missionId } = options.notification;
  void options
    .refreshMissionSummary(options.notification)
    .catch((error: unknown) => options.reportSummaryRefreshFailure(error, missionId));
}

async function retryRefresh(
  notification: MissionStatusNotification,
  refresh: (notification: MissionStatusNotification) => Promise<void>,
  retryDelaysMs: readonly number[],
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await refresh(notification);
      return;
    } catch (error) {
      failure = error;
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined) break;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw failure;
}

export function forwardMissionWorkNotification(options: {
  readonly notification: MissionWorkNotification;
  readonly getSender: () => MissionRendererUpdateSender | null;
}): void {
  const { audience, update } = options.notification;
  if (audience !== "user") return;
  options.getSender()?.send("missions:work:updated", update);
}

/** Apply the Core-backed status carried by the notification to a stale Desktop snapshot. */
export function projectMissionStatusNotification(
  mission: Mission,
  notification: MissionStatusNotification,
): Mission {
  const execution = notification.execution;
  if (execution === undefined || mission.execution?.id !== execution.id) return mission;
  const { error, waitReason, ...executionWithoutTransientState } = mission.execution;
  return {
    ...mission,
    execution: {
      ...executionWithoutTransientState,
      status: execution.status,
      ...(execution.status === "failed" && error !== undefined ? { error } : {}),
      ...(execution.status === "waiting" && waitReason !== undefined ? { waitReason } : {}),
    },
  };
}
