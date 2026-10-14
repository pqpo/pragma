import {
  AssetSyncSettingsV1Schema,
  AssetSyncStateV1Schema,
  AssetSyncJournalV1Schema,
} from "../schemas/v1.ts";
export const settingsV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: AssetSyncSettingsV1Schema,
  migrate(value: unknown) {
    const source = AssetSyncSettingsV1Schema.parse(value);
    return {
      schemaVersion: "pragma.asset-sync-settings/v2",
      remote: source.remote,
      autoPush: source.autoPush,
      ...(source.branch === undefined ? {} : { branch: source.branch }),
    };
  },
};
export const stateV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: AssetSyncStateV1Schema,
  migrate(value: unknown) {
    const source = AssetSyncStateV1Schema.parse(value);
    return {
      schemaVersion: "pragma.asset-sync-state/v2",
      source: source.source,
      repositoryInitialized: source.repositoryInitialized,
      bases: source.bases,
      remoteItems: source.remoteItems,
      conflicts: source.conflicts,
      restoreConflicts: source.restoreConflicts,
      ...(source.syncedAt === undefined ? {} : { syncedAt: source.syncedAt }),
    };
  },
};
export const journalV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: AssetSyncJournalV1Schema,
  migrate(value: unknown) {
    const source = AssetSyncJournalV1Schema.parse(value);
    return {
      ...source,
      schemaVersion: "pragma.asset-sync-journal/v2",
      incomingState: stateV1ToV2Step.migrate(source.incomingState),
    };
  },
};
