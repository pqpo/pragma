import type { MissionActivityReader } from "@pragma/local-host";

import type { Mission, MissionSummary } from "../../../shared/contracts/index.ts";
import type { MissionStore } from "./mission-store.ts";

/**
 * Adapts the Local Host-owned Mission activity projection to Desktop metadata.
 * Desktop owns titles, workspace presentation, and manual lifecycle state; it
 * does not decide whether an Execution is still working.
 */
export function createMissionReadModel(options: {
  readonly missions: Pick<MissionStore, "get" | "list">;
  readonly activity: MissionActivityReader;
}): Pick<MissionStore, "get" | "list"> {
  const projectMission = async (mission: Mission): Promise<Mission> => {
    if (mission.execution === undefined || !isActive(mission.execution.status)) return mission;
    const activity = await options.activity.read({
      missionId: mission.id,
      execution: {
        id: mission.execution.id,
        status: mission.execution.status,
        updatedAt: mission.updatedAt,
      },
    });
    if (activity.status === mission.execution.status) return mission;
    const terminal = isTerminal(activity.status);
    return {
      ...mission,
      execution: {
        ...mission.execution,
        status: activity.status,
        ...(terminal ? { finishedAt: activity.updatedAt } : {}),
      },
      updatedAt: latestTimestamp(mission.updatedAt, activity.updatedAt),
    };
  };

  const projectSummaries = async (
    missions: readonly MissionSummary[],
  ): Promise<MissionSummary[]> => {
    const active = missions.flatMap((mission) =>
      mission.execution?.id !== undefined && isActive(mission.execution.status)
        ? [
            {
              mission,
              input: {
                missionId: mission.id,
                execution: {
                  id: mission.execution.id,
                  status: mission.execution.status,
                  updatedAt: mission.updatedAt,
                },
              },
            },
          ]
        : [],
    );
    const activities = await options.activity.readMany(active.map((item) => item.input));
    const byMissionId = new Map(
      activities.map((activity, index) => [active[index]!.mission.id, activity] as const),
    );
    return missions.map((mission) => {
      const activity = byMissionId.get(mission.id);
      if (activity === undefined || mission.execution?.id === undefined) return mission;
      return {
        ...mission,
        execution: { ...mission.execution, status: activity.status },
        updatedAt: latestTimestamp(mission.updatedAt, activity.updatedAt),
      };
    });
  };

  return {
    async get(id) {
      return await projectMission(await options.missions.get(id));
    },
    async list() {
      return await projectSummaries(await options.missions.list());
    },
  };
}

function isActive(status: NonNullable<MissionSummary["execution"]>["status"]): boolean {
  return status === "queued" || status === "running" || status === "waiting";
}

function isTerminal(status: NonNullable<MissionSummary["execution"]>["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function latestTimestamp(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}
