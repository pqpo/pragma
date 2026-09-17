import type { MissionChatEntry, MissionChatUpdate } from "../../../shared/contracts/index.ts";

const unreadMissionOutputStorageKey = "pragma.desktop.missions.unread-output-ids.v1";
const missionOutputBoundariesStorageKey = "pragma.desktop.missions.output-boundaries.v1";

type MissionOutputStateReader = Pick<Storage, "getItem">;
type MissionOutputStateWriter = Pick<Storage, "removeItem" | "setItem">;

export interface MissionOutputBoundary {
  readonly streamId: string;
  readonly revision: number;
}

export type MissionOutputBoundaries = Readonly<Record<string, MissionOutputBoundary>>;

export function readMissionOutputBoundaries(
  storage: MissionOutputStateReader | undefined,
): MissionOutputBoundaries {
  try {
    const value = storage?.getItem(missionOutputBoundariesStorageKey);
    if (value === undefined || value === null) return {};
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([missionId, boundary]) => {
        if (typeof boundary !== "object" || boundary === null || Array.isArray(boundary)) return [];
        const streamId = (boundary as { streamId?: unknown }).streamId;
        const revision = (boundary as { revision?: unknown }).revision;
        return typeof streamId === "string" &&
          Number.isSafeInteger(revision) &&
          Number(revision) > 0
          ? [[missionId, { streamId, revision: Number(revision) }]]
          : [];
      }),
    );
  } catch {
    return {};
  }
}

export function writeMissionOutputBoundaries(
  storage: MissionOutputStateWriter | undefined,
  boundaries: MissionOutputBoundaries,
): void {
  try {
    if (Object.keys(boundaries).length === 0)
      storage?.removeItem(missionOutputBoundariesStorageKey);
    else storage?.setItem(missionOutputBoundariesStorageKey, JSON.stringify(boundaries));
  } catch {
    // Storage failures must not prevent live Mission output from rendering.
  }
}

export function acceptMissionChatUpdate(
  boundaries: MissionOutputBoundaries,
  update: MissionChatUpdate,
): { readonly accepted: boolean; readonly boundaries: MissionOutputBoundaries } {
  const streamId = update.streamId;
  const current = boundaries[update.missionId];
  if (
    current !== undefined &&
    current.streamId === streamId &&
    update.revision <= current.revision
  ) {
    return { accepted: false, boundaries };
  }
  return {
    accepted: true,
    boundaries: {
      ...boundaries,
      [update.missionId]: { streamId, revision: update.revision },
    },
  };
}

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

export function recordMissionChatUpdateIds(
  unreadMissionIds: readonly string[],
  update: MissionChatUpdate,
  selectedMissionIdAtReceipt: string | null,
  currentEntries: readonly MissionChatEntry[] = [],
): readonly string[] {
  return missionChatUpdateHasUserVisibleOutput(update, currentEntries)
    ? recordMissionOutputIds(unreadMissionIds, update.missionId, selectedMissionIdAtReceipt)
    : unreadMissionIds;
}

export function missionChatUpdateHasUserVisibleOutput(
  update: MissionChatUpdate,
  currentEntries: readonly MissionChatEntry[] = [],
): boolean {
  // Most invalidations only refresh status or metadata. Producers explicitly mark the uncommon
  // repair/settlement invalidation that makes previously unprojected output visible.
  if (update.kind === "invalidate") return update.userVisibleOutput === true;
  const currentById = new Map(currentEntries.map((entry) => [entry.id, entry] as const));
  return update.patches.some((patch) => {
    if (patch.type === "entry.append") return patch.delta.length > 0;
    if (patch.type !== "entry.upsert") return false;
    const nextFingerprint = missionEntryVisibleOutputFingerprint(patch.entry);
    if (nextFingerprint === undefined) return false;
    const current = currentById.get(patch.entry.id);
    return (
      current === undefined || missionEntryVisibleOutputFingerprint(current) !== nextFingerprint
    );
  });
}

function missionEntryVisibleOutputFingerprint(entry: MissionChatEntry): string | undefined {
  switch (entry.kind) {
    case "assistant":
    case "thinking":
      return entry.content === "" ? undefined : `${entry.kind}:${entry.content}`;
    case "tool": {
      const visible = `${entry.outputPreview ?? ""}:${entry.error ?? ""}`;
      return visible === ":" ? undefined : `tool:${visible}`;
    }
    case "agent_activity":
      return `agent:${entry.action}:${entry.phase}:${entry.label ?? ""}:${entry.error ?? ""}`;
    case "user":
    case "context_operation":
      return undefined;
  }
}
