import type { Mission } from "@pragma/shared";

// Process-local proof from the preparation boundary, never inferred from an error
// message or a missing Mission projection after a potentially billable call.
const unstartedFailures = new WeakMap<object, Set<string>>();

export function consumeUnstartedMissionPreparationFailure(
  error: unknown,
  missionId: string,
): boolean {
  if (typeof error !== "object" || error === null) return false;
  const missions = unstartedFailures.get(error);
  if (!missions?.delete(missionId)) return false;
  if (missions.size === 0) unstartedFailures.delete(error);
  return true;
}

export async function withMissionPreparationFailure<T>(
  mission: Pick<Mission, "id" | "execution">,
  prepare: () => Promise<T>,
): Promise<T> {
  try {
    return await prepare();
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      if (mission.execution === undefined) {
        const missions = unstartedFailures.get(error) ?? new Set<string>();
        missions.add(mission.id);
        unstartedFailures.set(error, missions);
      } else {
        unstartedFailures.get(error)?.delete(mission.id);
      }
    }
    throw error;
  }
}
