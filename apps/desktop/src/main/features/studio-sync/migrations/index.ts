import { defineStateMigrationChain } from "@pragma/core";
import { CoreAssetSyncConfigurationSchema } from "../../../../shared/contracts/index.ts";
import { StateSchema, JournalSchema } from "../asset-sync-state.ts";
import { settingsV1ToV2Step, stateV1ToV2Step, journalV1ToV2Step } from "./steps/v1-to-v2.ts";
import { journalV2ToV3Step } from "./steps/v2-to-v3.ts";
export const settingsMigrationChain = defineStateMigrationChain({
  family: "pragma.asset-sync-settings",
  currentVersion: 2,
  currentSchema: CoreAssetSyncConfigurationSchema,
  steps: [settingsV1ToV2Step],
});
export const stateMigrationChain = defineStateMigrationChain({
  family: "pragma.asset-sync-state",
  currentVersion: 2,
  currentSchema: StateSchema,
  steps: [stateV1ToV2Step],
});
export const journalMigrationChain = defineStateMigrationChain({
  family: "pragma.asset-sync-journal",
  currentVersion: 3,
  currentSchema: JournalSchema,
  steps: [journalV1ToV2Step, journalV2ToV3Step],
});
