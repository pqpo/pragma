import type { MissionSummary } from "../../../../shared/contracts/index.ts";

export interface MissionRailVisibleLimits {
  readonly waitingInput: number;
  readonly active: number;
  readonly completed: number;
}

export interface MissionRailResolvedGroup {
  readonly visibleMissions: readonly MissionSummary[];
  readonly hiddenCount: number;
}

export interface MissionRailResolvedGroups {
  readonly waitingInput: MissionRailResolvedGroup;
  readonly active: MissionRailResolvedGroup;
  readonly completed: MissionRailResolvedGroup;
}

export function resolveMissionRailGroups(input: {
  readonly missions: readonly MissionSummary[];
  readonly pinnedMissionIds: readonly string[];
  readonly visibleLimits: MissionRailVisibleLimits;
  readonly selectedMissionId?: string | null | undefined;
}): MissionRailResolvedGroups {
  const waitingInput = input.missions
    .filter(isWaitingInputMission)
    .toSorted((left, right) => comparePinnedMissions(left, right, input.pinnedMissionIds));
  const active = input.missions
    .filter((mission) => mission.lifecycleStatus === "active" && !isWaitingInputMission(mission))
    .toSorted((left, right) => comparePinnedMissions(left, right, input.pinnedMissionIds));
  const completed = input.missions.filter((mission) => mission.lifecycleStatus === "completed");

  return {
    waitingInput: resolveMissionRailGroup(
      waitingInput,
      input.visibleLimits.waitingInput,
      input.selectedMissionId,
    ),
    active: resolveMissionRailGroup(active, input.visibleLimits.active, input.selectedMissionId),
    completed: resolveMissionRailGroup(
      completed,
      input.visibleLimits.completed,
      input.selectedMissionId,
    ),
  };
}

function resolveMissionRailGroup(
  missions: readonly MissionSummary[],
  visibleLimit: number,
  selectedMissionId: string | null | undefined,
): MissionRailResolvedGroup {
  // Restoring a tab must also reveal a selection beyond its initial page.
  const selectedIndex = missions.findIndex((mission) => mission.id === selectedMissionId);
  const boundedLimit = Math.max(0, visibleLimit, selectedIndex + 1);
  return {
    visibleMissions: missions.slice(0, boundedLimit),
    hiddenCount: Math.max(0, missions.length - boundedLimit),
  };
}

function isWaitingInputMission(mission: MissionSummary): boolean {
  return mission.lifecycleStatus === "active" && mission.execution?.status === "waiting";
}

function comparePinnedMissions(
  left: MissionSummary,
  right: MissionSummary,
  pinnedMissionIds: readonly string[],
): number {
  const leftPinnedIndex = pinnedMissionIds.indexOf(left.id);
  const rightPinnedIndex = pinnedMissionIds.indexOf(right.id);
  const leftPinned = leftPinnedIndex >= 0;
  const rightPinned = rightPinnedIndex >= 0;
  if (leftPinned && rightPinned) return leftPinnedIndex - rightPinnedIndex;
  if (leftPinned) return -1;
  if (rightPinned) return 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}
