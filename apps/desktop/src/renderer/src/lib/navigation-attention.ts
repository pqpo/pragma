import type {
  MissionSummary,
  MissionUpdate,
  MissionStatusUpdate,
} from "../../../shared/contracts/index.ts";
import {
  applyMissionStatusUpdateToSummary,
  missionToSummary,
} from "../pages/missions/mission-page-utils.ts";

export type NavigationMissionEvent = MissionUpdate | MissionStatusUpdate;

export function reconcileNavigationMissions(
  snapshot: readonly MissionSummary[],
  events: readonly NavigationMissionEvent[],
): readonly MissionSummary[] {
  const missions = new Map(snapshot.map((mission) => [mission.id, mission]));
  for (const event of events) {
    if ("kind" in event) {
      if (event.kind === "remove") missions.delete(event.missionId);
      else missions.set(event.mission.id, missionToSummary(event.mission, event.source));
    } else {
      const mission = missions.get(event.missionId);
      if (mission !== undefined)
        missions.set(mission.id, applyMissionStatusUpdateToSummary(mission, event));
    }
  }
  return [...missions.values()];
}

export interface NavigationAttention {
  readonly missions: boolean;
  readonly studio: boolean;
  readonly skills: boolean;
  readonly knowledge: boolean;
  readonly memory: boolean;
}

export const emptyNavigationAttention: NavigationAttention = {
  missions: false,
  studio: false,
  skills: false,
  knowledge: false,
  memory: false,
};

export function missionNeedsAttention(
  mission: MissionSummary,
  unreadMissionIds: readonly string[],
): boolean {
  if (mission.source.type === "internal" || mission.lifecycleStatus === "completed") return false;
  return (
    unreadMissionIds.includes(mission.id) ||
    (mission.execution?.status === "waiting" && mission.execution.waitReason !== "experts")
  );
}
