/** Deduplicate pending Attention stops while allowing failed cleanup to run again. */
export function createMissionAttentionRetirement(stop: (missionId: string) => Promise<void>) {
  const pending = new Map<string, Promise<void>>();
  const retire = (missionId: string): Promise<void> => {
    const existing = pending.get(missionId);
    if (existing !== undefined) return existing;
    const stopping = Promise.resolve().then(async () => await stop(missionId));
    pending.set(missionId, stopping);
    void stopping.catch(() => {
      if (pending.get(missionId) === stopping) pending.delete(missionId);
    });
    return stopping;
  };
  return {
    stop: retire,
    async finish(missionId: string): Promise<void> {
      const stopping = retire(missionId);
      await stopping;
      if (pending.get(missionId) === stopping) pending.delete(missionId);
    },
  };
}
