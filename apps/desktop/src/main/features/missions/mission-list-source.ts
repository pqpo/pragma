import type {
  ContextStoreRevisionRequest,
  Mission,
  MissionSummary,
} from "../../../shared/contracts/index.ts";

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
    default:
      return { type: "internal" };
  }
}
