import { MissionStoreError, type MissionStore } from "@pragma/local-host";
import type { ManagedSkillRevisionJob } from "@pragma/built-in-agents/contracts";

export function createSkillRevisionMissionRestorer(
  missions: Pick<MissionStore, "get" | "mountSkillRevisionDraft">,
) {
  return async (job: ManagedSkillRevisionJob): Promise<void | "mission_missing"> => {
    if (job.missionId === undefined) return;
    try {
      await missions.get(job.missionId);
      await missions.mountSkillRevisionDraft({
        id: job.missionId,
        draftId: job.draftId,
        revisionJobId: job.id,
        capabilityId: job.request.capabilityId,
        restoreSessionBinding: true,
      });
    } catch (error) {
      if (error instanceof MissionStoreError && error.code === "mission_not_found")
        return "mission_missing";
      throw error;
    }
  };
}
