/** Retain only pending observers; an older completion must not erase its replacement. */
export function trackMissionDeletionSettlement(
  pending: Map<string, Promise<void>>,
  missionId: string,
  settlement: Promise<void>,
): void {
  pending.set(missionId, settlement);
  void settlement
    .finally(() => {
      if (pending.get(missionId) === settlement) pending.delete(missionId);
    })
    .catch(() => undefined);
}
