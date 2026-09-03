import type { MissionChatUpdate } from "../../../shared/contracts/index.ts";

const unreadMissionOutputStorageKey = "pragma.desktop.missions.unread-output-ids.v1";

type MissionOutputStateReader = Pick<Storage, "getItem">;
type MissionOutputStateWriter = Pick<Storage, "removeItem" | "setItem">;

export function readUnreadMissionOutputIds(
  storage: MissionOutputStateReader | undefined,
): string[] {
  try {
    const value = storage?.getItem(unreadMissionOutputStorageKey);
    if (value === undefined || value === null) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item !== ""),
      ),
    ];
  } catch {
    return [];
  }
}

export function writeUnreadMissionOutputIds(
  storage: MissionOutputStateWriter | undefined,
  missionIds: readonly string[],
): void {
  try {
    const uniqueMissionIds = [...new Set(missionIds.map((missionId) => missionId.trim()))].filter(
      (missionId) => missionId !== "",
    );
    if (uniqueMissionIds.length === 0) storage?.removeItem(unreadMissionOutputStorageKey);
    else storage?.setItem(unreadMissionOutputStorageKey, JSON.stringify(uniqueMissionIds));
  } catch {
    // Storage failures must not prevent live Mission output from rendering.
  }
}

export function markMissionOutputReadIds(
  unreadMissionIds: readonly string[],
  missionId: string,
): readonly string[] {
  return unreadMissionIds.includes(missionId)
    ? unreadMissionIds.filter((currentId) => currentId !== missionId)
    : unreadMissionIds;
}

export function recordMissionOutputIds(
  unreadMissionIds: readonly string[],
  outputMissionId: string,
  selectedMissionId: string | null,
): readonly string[] {
  if (selectedMissionId === outputMissionId) {
    return markMissionOutputReadIds(unreadMissionIds, outputMissionId);
  }
  return unreadMissionIds.includes(outputMissionId)
    ? unreadMissionIds
    : [...unreadMissionIds, outputMissionId];
}

export function missionChatUpdateHasUserVisibleOutput(update: MissionChatUpdate): boolean {
  if (update.kind === "invalidate") return true;
  return update.patches.some((patch) => {
    if (patch.type === "entry.append") return true;
    if (patch.type !== "entry.upsert") return false;
    return patch.entry.kind !== "user" && patch.entry.kind !== "context_operation";
  });
}
