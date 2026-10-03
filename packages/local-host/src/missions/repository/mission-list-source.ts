import type { ContextStoreRevisionRequest } from "@pragma/built-in-agents/contracts";
import type { Mission, MissionRepositorySummary as MissionSummary } from "@pragma/shared";

/** The automation rail is an inbox for independently running background work. */
export async function resolveMissionListSource(
  mission: Mission,
  getRevisionSource: (jobId: string) => Promise<ContextStoreRevisionRequest["source"]>,
): Promise<MissionSummary["source"]> {
  switch (mission.origin.type) {
    case "user":
      return { type: "task" };
    case "automation":
      return { type: "automation", automationRef: mission.origin.automationRef };
    case "system-store-revision": {
      const source = await getRevisionSource(mission.origin.jobId);
      return source === "expert-reflection"
        ? { type: "internal" }
        : {
            type: "managed-automation",
            kind: "knowledge-revision",
            jobId: mission.origin.jobId,
            storeId: mission.origin.storeId,
          };
    }
    case "system-skill-revision":
      return {
        type: "managed-automation",
        kind: "skill-revision",
        jobId: mission.origin.jobId,
        capabilityId: mission.origin.capabilityId,
      };
    default:
      return { type: "internal" };
  }
}
