import { z } from "zod";

const legacyMissionDraftStorageKey = "pragma.desktop.missions.composer-drafts.v1";
const missionDraftStorageKeyPrefix = "pragma.desktop.missions.composer-draft.v2.";
const MissionDraftSchema = z.string().max(100_000);
const LegacyMissionDraftsSchema = z.record(z.string().min(1), MissionDraftSchema);

type MissionDraftReader = Pick<Storage, "getItem">;
type MissionDraftWriter = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function missionDraftStorageKey(missionId: string): string {
  return `${missionDraftStorageKeyPrefix}${encodeURIComponent(missionId)}`;
}

function readLegacyMissionDrafts(storage: MissionDraftReader): Record<string, string> {
  const value = storage.getItem(legacyMissionDraftStorageKey);
  if (value === null) return {};
  const parsed = LegacyMissionDraftsSchema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : {};
}

export function readMissionDraft(
  storage: MissionDraftWriter | undefined,
  missionId: string,
): string {
  try {
    if (storage === undefined) return "";
    const current = storage.getItem(missionDraftStorageKey(missionId));
    if (current !== null) {
      const parsed = MissionDraftSchema.safeParse(current);
      return parsed.success ? parsed.data : "";
    }

    const legacyDrafts = readLegacyMissionDrafts(storage);
    const legacyDraft = legacyDrafts[missionId];
    if (legacyDraft === undefined) return "";

    // Migrate only the requested Mission. This happens outside the input hot path,
    // and a quota failure must not hide the readable legacy value from the user.
    try {
      storage.setItem(missionDraftStorageKey(missionId), legacyDraft);
      delete legacyDrafts[missionId];
      if (Object.keys(legacyDrafts).length === 0) storage.removeItem(legacyMissionDraftStorageKey);
      else storage.setItem(legacyMissionDraftStorageKey, JSON.stringify(legacyDrafts));
    } catch {
      // The legacy value remains the authoritative fallback.
    }
    return legacyDraft;
  } catch {
    return "";
  }
}

export function writeMissionDraft(
  storage: MissionDraftWriter | undefined,
  missionId: string,
  draft: string,
): void {
  try {
    if (storage === undefined) return;
    const parsed = MissionDraftSchema.safeParse(draft);
    if (!parsed.success) return;
    // An empty value is intentionally retained as a tombstone. It prevents a
    // legacy v1 draft from being resurrected without touching the v1 collection
    // during later keystroke-driven writes.
    storage.setItem(missionDraftStorageKey(missionId), parsed.data);
  } catch {
    // A draft persistence failure must not block Mission chat.
  }
}

/** A filtered task list cannot prove that an absent Mission was deleted. */
export function removeMissionDrafts(
  storage: MissionDraftWriter | undefined,
  removedMissionIds: ReadonlySet<string>,
): void {
  try {
    if (storage === undefined) return;
    for (const missionId of removedMissionIds) {
      storage.removeItem(missionDraftStorageKey(missionId));
    }

    const legacyDrafts = readLegacyMissionDrafts(storage);
    let changed = false;
    for (const missionId of removedMissionIds) {
      if (!(missionId in legacyDrafts)) continue;
      delete legacyDrafts[missionId];
      changed = true;
    }
    if (!changed) return;
    if (Object.keys(legacyDrafts).length === 0) storage.removeItem(legacyMissionDraftStorageKey);
    else storage.setItem(legacyMissionDraftStorageKey, JSON.stringify(legacyDrafts));
  } catch {
    // Cleanup is best-effort when browser storage is unavailable.
  }
}

export interface MissionDraftPersistence {
  readonly schedule: (missionId: string, draft: string) => void;
  readonly clear: (missionId: string) => void;
  readonly remove: (missionId: string) => void;
  readonly flush: () => void;
  readonly dispose: () => void;
}

export function createMissionDraftPersistence(
  storage: MissionDraftWriter | undefined,
  delayMs = 400,
): MissionDraftPersistence {
  let pending: { readonly missionId: string; readonly draft: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = (): void => {
    cancelTimer();
    const current = pending;
    pending = undefined;
    if (current !== undefined) writeMissionDraft(storage, current.missionId, current.draft);
  };

  return {
    schedule(missionId, draft) {
      if (pending !== undefined && pending.missionId !== missionId) flush();
      cancelTimer();
      const next = { missionId, draft };
      pending = next;
      timer = setTimeout(() => {
        if (pending !== next) return;
        timer = undefined;
        pending = undefined;
        writeMissionDraft(storage, missionId, draft);
      }, delayMs);
    },
    clear(missionId) {
      if (pending?.missionId === missionId) {
        cancelTimer();
        pending = undefined;
      }
      writeMissionDraft(storage, missionId, "");
    },
    remove(missionId) {
      if (pending?.missionId === missionId) {
        cancelTimer();
        pending = undefined;
      }
      removeMissionDrafts(storage, new Set([missionId]));
    },
    flush,
    dispose() {
      flush();
    },
  };
}
