import type { MissionChatEntry } from "@pragma/shared";

export function missionChatEntryDisplayTime(entry: MissionChatEntry): string {
  return entry.kind === "user" ? (entry.delivery?.activatedAt ?? entry.createdAt) : entry.createdAt;
}

/** Preserve output event order while placing delivered inputs at their effective time. */
export function orderMissionChatEntries(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const delivered = entries
    .filter(
      (entry) =>
        entry.kind === "user" &&
        (entry.delivery?.activatedAt !== undefined || entry.delivery?.effectiveMode === "steer"),
    )
    .toSorted((left, right) =>
      missionChatEntryDisplayTime(left).localeCompare(missionChatEntryDisplayTime(right)),
    );
  const deliveredIds = new Set(delivered.map((entry) => entry.id));
  const ordered = entries.filter((entry) => !deliveredIds.has(entry.id));
  for (const entry of delivered) {
    const time = missionChatEntryDisplayTime(entry);
    const index = ordered.findIndex((candidate) => missionChatEntryDisplayTime(candidate) > time);
    ordered.splice(index < 0 ? ordered.length : index, 0, entry);
  }
  return ordered;
}
