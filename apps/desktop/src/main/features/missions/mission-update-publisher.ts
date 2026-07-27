import { MissionUpdateSchema, type MissionUpdate } from "../../../shared/contracts/index.ts";

export interface MissionUpdateSender {
  send(channel: "missions:updated", update: MissionUpdate): void;
}

export function publishMissionUpdate(
  getSender: () => MissionUpdateSender | null,
  update: unknown,
  reportFailure: (error: unknown) => void = reportMissionUpdateFailure,
): void {
  try {
    const parsed = MissionUpdateSchema.parse(update);
    getSender()?.send("missions:updated", parsed);
  } catch (error) {
    try {
      reportFailure(error);
    } catch {
      // A best-effort renderer notification must never change the completed mutation result.
    }
  }
}

function reportMissionUpdateFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      component: "desktop.missions",
      event: "mission_update_publish_failed",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
