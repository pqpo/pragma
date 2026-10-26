import type { MissionSummary } from "../../../../shared/contracts/index.ts";
import { resolveMissionRailGroups } from "./mission-rail-groups.ts";

export function missionTabSelectionKey(source: string, workspacePath: string | null): string {
  return JSON.stringify([source, workspacePath]);
}

/** Filter the presented summaries, so selection and the rail use identical candidates. */
export function filterMissionTabMissions(
  missions: readonly MissionSummary[],
  source: "task" | "automation",
  workspacePath: string | null,
  search: string,
): readonly MissionSummary[] {
  const query = search.trim().toLocaleLowerCase();
  return missions.filter(
    (mission) =>
      mission.source.type !== "internal" &&
      (mission.source.type === "task" ? "task" : "automation") === source &&
      (workspacePath === null || mission.workspace.path === workspacePath) &&
      (query === "" ||
        [mission.title, mission.workspace.basename, mission.executor.name].some((value) =>
          value.toLocaleLowerCase().includes(query),
        )),
  );
}

export function selectMissionTabId(
  missions: readonly MissionSummary[],
  pinnedMissionIds: readonly string[],
  rememberedId?: string | null,
): string | null {
  if (rememberedId != null && missions.some((mission) => mission.id === rememberedId)) {
    return rememberedId;
  }
  const groups = resolveMissionRailGroups({
    missions,
    pinnedMissionIds,
    visibleLimits: { waitingInput: 1, active: 1, completed: 1 },
  });
  return (
    groups.waitingInput.visibleMissions[0]?.id ??
    groups.active.visibleMissions[0]?.id ??
    groups.completed.visibleMissions[0]?.id ??
    null
  );
}

/** A missing rail entry can still have a valid, independently accessible detail. */
export async function resolveUnlistedMissionSelection(input: {
  readonly id: string;
  readonly getSource: (id: string) => Promise<MissionSummary["source"]>;
  readonly isCurrent: () => boolean;
}): Promise<"detail" | "fallback" | "deleted" | "stale"> {
  try {
    const source = await input.getSource(input.id);
    if (!input.isCurrent()) return "stale";
    return source.type === "internal" ? "detail" : "fallback";
  } catch (error) {
    if (!input.isCurrent()) return "stale";
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "mission_not_found"
    )
      return "deleted";
    throw error;
  }
}
