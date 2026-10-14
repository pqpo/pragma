import { withFileLock } from "./file-lock.ts";
import { join } from "node:path";
import { encodePragmaPathSegment } from "./pragma-paths.ts";

export const missionAggregateLockPath = (missionsPath: string, missionId: string): string =>
  join(missionsPath, ".locks", `${missionId}.aggregate.lock`);

export const missionSemanticWriteLockPath = (missionsPath: string, missionId: string): string =>
  join(missionsPath, ".locks", `${missionId}.semantic-write.lock`);

export const missionRepositoryLockPath = (missionsPath: string, missionId: string): string =>
  join(missionsPath, ".locks", `${encodePragmaPathSegment(missionId)}.lock`);

/** Drain semantic transactions before locking the aggregate and then repository metadata. */
export async function withMissionStorageDeletionBarrier<T>(
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
