import { z } from "zod";

const missionDraftStorageKey = "pragma.desktop.missions.composer-drafts.v1";
const MissionDraftsSchema = z.record(z.string().min(1), z.string().max(100_000));

type MissionDraftReader = Pick<Storage, "getItem">;
type MissionDraftWriter = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function readMissionDrafts(storage: MissionDraftReader | undefined): Record<string, string> {
  try {
    const value = storage?.getItem(missionDraftStorageKey);
    if (value === undefined || value === null) return {};
    const parsed = MissionDraftsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function readMissionDraft(
  storage: MissionDraftReader | undefined,
  missionId: string,
): string {
  return readMissionDrafts(storage)[missionId] ?? "";
}

export function writeMissionDraft(
  storage: MissionDraftWriter | undefined,
  missionId: string,
  draft: string,
): void {
  try {
    const drafts = readMissionDrafts(storage);
    if (draft === "") delete drafts[missionId];
    else drafts[missionId] = draft;
    if (Object.keys(drafts).length === 0) storage?.removeItem(missionDraftStorageKey);
    else storage?.setItem(missionDraftStorageKey, JSON.stringify(drafts));
  } catch {
    // A draft persistence failure must not block Mission chat.
  }
}

export function pruneMissionDrafts(
  storage: MissionDraftWriter | undefined,
  activeMissionIds: ReadonlySet<string>,
): void {
  try {
    const drafts = readMissionDrafts(storage);
    const retained = Object.fromEntries(
      Object.entries(drafts).filter(([missionId, draft]) => {
        return activeMissionIds.has(missionId) && draft !== "";
      }),
    );
    if (Object.keys(retained).length === 0) storage?.removeItem(missionDraftStorageKey);
    else storage?.setItem(missionDraftStorageKey, JSON.stringify(retained));
  } catch {
    // Cleanup is best-effort when browser storage is unavailable.
  }
}
