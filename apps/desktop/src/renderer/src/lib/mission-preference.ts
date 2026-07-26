const lastOpenedMissionStorageKey = "pragma.desktop.missions.last-opened-id";
const pinnedMissionStorageKey = "pragma.desktop.missions.pinned-ids";

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

export function readPinnedMissionIds(storage: MissionPreferenceReader | undefined): string[] {
  try {
    const value = storage?.getItem(pinnedMissionStorageKey);
    if (value === undefined || value === null) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const missionIds = parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    return [...new Set(missionIds)];
  } catch {
    return [];
  }
}

export function writePinnedMissionIds(
  storage: MissionPreferenceWriter | undefined,
  missionIds: readonly string[],
): void {
  try {
    const uniqueMissionIds = [...new Set(missionIds.map((missionId) => missionId.trim()))].filter(
      (missionId) => missionId !== "",
    );
    if (uniqueMissionIds.length === 0) storage?.removeItem(pinnedMissionStorageKey);
    else storage?.setItem(pinnedMissionStorageKey, JSON.stringify(uniqueMissionIds));
  } catch {
    // Storage failures must not prevent Missions navigation for the current session.
  }
}

export function togglePinnedMissionId(missionIds: readonly string[], missionId: string): string[] {
  if (missionIds.includes(missionId)) {
    return missionIds.filter((currentMissionId) => currentMissionId !== missionId);
  }
  return [missionId, ...missionIds];
}
