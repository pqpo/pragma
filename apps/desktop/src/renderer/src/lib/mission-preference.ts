const lastOpenedMissionStorageKey = "pragma.desktop.missions.last-opened-id";

type MissionPreferenceReader = Pick<Storage, "getItem">;
type MissionPreferenceWriter = Pick<Storage, "removeItem" | "setItem">;

export function readLastOpenedMissionId(
  storage: MissionPreferenceReader | undefined,
): string | null {
  try {
    const value = storage?.getItem(lastOpenedMissionStorageKey)?.trim();
    return value === undefined || value === "" ? null : value;
  } catch {
    return null;
  }
}

export function writeLastOpenedMissionId(
  storage: MissionPreferenceWriter | undefined,
  missionId: string | null,
): void {
  try {
    if (missionId === null) storage?.removeItem(lastOpenedMissionStorageKey);
    else storage?.setItem(lastOpenedMissionStorageKey, missionId);
  } catch {
    // Storage failures must not prevent Missions navigation for the current session.
  }
}

export function selectPreferredMissionId(
  missions: readonly { readonly id: string }[],
  lastOpenedId: string | null,
): string | null {
  return missions.find((mission) => mission.id === lastOpenedId)?.id ?? missions[0]?.id ?? null;
}
