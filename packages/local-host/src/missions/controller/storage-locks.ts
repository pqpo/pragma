import { withFileLock } from "@pragma/core";
import { join } from "node:path";

export const missionAggregateLockPath = (missionsPath: string, missionId: string): string =>
  join(missionsPath, ".locks", `${missionId}.aggregate.lock`);

export const missionSemanticWriteLockPath = (missionsPath: string, missionId: string): string =>
  join(missionsPath, ".locks", `${missionId}.semantic-write.lock`);

/** Drain semantic transactions before locking the aggregate and then repository metadata. */
export async function withMissionControllerDeletionBarrier<T>(
  missionsPath: string,
  missionId: string,
  action: () => Promise<T>,
): Promise<T> {
  return await withFileLock(
    missionSemanticWriteLockPath(missionsPath, missionId),
    async () =>
      await withFileLock(missionAggregateLockPath(missionsPath, missionId), action, {
        operation: "mission.deletion-aggregate-barrier",
      }),
    { operation: "mission.deletion-semantic-barrier" },
  );
}
