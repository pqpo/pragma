import type { Mission } from "@pragma/shared";
import type { createMissionDelivery } from "./mission-delivery.ts";

/** Reassociate durable receipts only for an explicitly accessed Mission, never a list scan. */
export function createMissionReceiptRecovery(input: {
  readonly readMission: (missionId: string) => Promise<Mission | undefined>;
  readonly getDelivery: () => Promise<MissionDelivery | undefined>;
  readonly withOwner?:
    ((missionId: string, operation: () => Promise<void>) => Promise<void>) | undefined;
  readonly onError: (missionId: string, error: unknown) => void;
}) {
  const active = new Map<string, Promise<void>>();
  let closed = false;
  return {
    wake(missionId: string): void {
      if (closed || active.has(missionId)) return;
      const operation = (async () => {
        const mission = await input.readMission(missionId);
        if (mission?.execution === undefined) return;
        const delivery = await input.getDelivery();
        if (delivery === undefined) return;
        // A canonical fact can reach custody before its original Host registers
        // the association. Only the persisted owner envelope supplies identity.
        const settle = async () => await delivery.recoverMission(mission);
        if (input.withOwner === undefined) await settle();
        else await input.withOwner(missionId, settle);
      })()
        .catch((error: unknown) => input.onError(missionId, error))
        .finally(() => active.delete(missionId));
      active.set(missionId, operation);
    },
    async close() {
      closed = true;
      await Promise.all(active.values());
    },
  };
}

type MissionDelivery = Awaited<ReturnType<typeof createMissionDelivery>>;
