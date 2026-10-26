import { AssetSyncJournalV3Schema } from "../schemas/v3.ts";
import { migrateSyncDslItem, upgradeSyncBaselines } from "../dsl-fingerprints.ts";
import { stateV2ToV3Step } from "./v2-to-v3.ts";

export const journalV3ToV4Step = {
  fromVersion: 3,
  toVersion: 4,
  inputSchema: AssetSyncJournalV3Schema,
  migrate(value: unknown) {
    const source = AssetSyncJournalV3Schema.parse(value);
    const expected = { ...source.expected };
    const incomingState = stateV2ToV3Step.migrate(source.incomingState);
    const changes = source.changes.map((change) => {
      if (
        (change.local && change.local.key !== change.key) ||
        (change.remote && change.remote.key !== change.key)
      )
        throw new Error(`Sync journal change identity does not match payload: ${change.key}`);
      const local = change.local && migrateSyncDslItem(change.local);
      const remote = change.remote && migrateSyncDslItem(change.remote);
      for (const [before, after] of [
        [change.local, local],
        [change.remote, remote],
      ] as const) {
        if (!before || !after) continue;
        if (expected[change.key] === before.fingerprint) expected[change.key] = after.fingerprint;
        if (incomingState.bases[change.key] === before.fingerprint)
          incomingState.bases[change.key] = after.fingerprint;
        for (const summaries of [incomingState.remoteItems, incomingState.unavailableItems]) {
          const summary = summaries[change.key];
          if (summary?.fingerprint === before.fingerprint)
            summaries[change.key] = { ...summary, fingerprint: after.fingerprint };
        }
      }
      return { ...change, ...(local && { local }), ...(remote && { remote }) };
    });
    return {
      ...source,
      schemaVersion: "pragma.asset-sync-journal/v4",
      changes,
      expected,
      incomingState: upgradeSyncBaselines(
        incomingState,
        changes.flatMap(({ local, remote }) =>
          [local, remote].filter((item) => item !== undefined),
        ),
      ),
    };
  },
};
