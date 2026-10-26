import { SkillDataSchema, validateTransferredSkill } from "@pragma/local-host/deployment";
import type { CoreAssetSyncItem } from "../../../../../shared/contracts/index.ts";
import { fingerprint } from "../../../asset-transfer/asset-transfer-fingerprint.ts";
import { AssetSyncJournalV2Schema, AssetSyncStateV2Schema } from "../schemas/v2.ts";

export const stateV2ToV3Step = {
  fromVersion: 2,
  toVersion: 3,
  inputSchema: AssetSyncStateV2Schema,
  migrate(value: unknown) {
    return {
      ...AssetSyncStateV2Schema.parse(value),
      schemaVersion: "pragma.asset-sync-state/v3" as const,
    };
  },
};

export const journalV2ToV3Step = {
  fromVersion: 2,
  toVersion: 3,
  inputSchema: AssetSyncJournalV2Schema,
  migrate(value: unknown) {
    const source = AssetSyncJournalV2Schema.parse(value);
    const normalize = (item: CoreAssetSyncItem | undefined): CoreAssetSyncItem | undefined => {
      if (item?.kind !== "skill") return item;
      const data = validateTransferredSkill(SkillDataSchema.parse(item.data), {
        id: item.key.slice("skill:".length),
      });
      return { ...item, data, fingerprint: fingerprint(data) };
    };
    const expected = { ...source.expected };
    const incomingState = {
      ...source.incomingState,
      bases: { ...source.incomingState.bases },
      remoteItems: { ...source.incomingState.remoteItems },
      unavailableItems: { ...source.incomingState.unavailableItems },
    };
    const changes = source.changes.map((change) => {
      const local = normalize(change.local);
      const remote = normalize(change.remote);
      if (change.local?.kind !== "skill" && change.remote?.kind !== "skill") return change;
      const rewrite = (hash: string | null | undefined) => {
        if (hash !== undefined && hash !== null) {
          if (change.local && hash === change.local.fingerprint) return local!.fingerprint;
          if (change.remote && hash === change.remote.fingerprint) return remote!.fingerprint;
        }
        return hash;
      };
      if (Object.hasOwn(expected, change.key))
        expected[change.key] = rewrite(expected[change.key]) ?? null;
      const base = rewrite(incomingState.bases[change.key]);
      if (base !== undefined && base !== null) incomingState.bases[change.key] = base;
      for (const items of [incomingState.remoteItems, incomingState.unavailableItems]) {
        const item = items[change.key];
        if (item) items[change.key] = { ...item, fingerprint: rewrite(item.fingerprint)! };
      }
      return {
        ...change,
        ...(local === undefined ? {} : { local }),
        ...(remote === undefined ? {} : { remote }),
      };
    });
    return {
      ...source,
      schemaVersion: "pragma.asset-sync-journal/v3",
      changes,
      expected,
      incomingState,
    };
  },
};
