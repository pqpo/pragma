import { defineStateMigrationChain } from "@pragma/core";
import { CoreAssetSyncConfigurationSchema } from "../../../../shared/contracts/index.ts";
import { StateSchema, JournalSchema } from "../asset-sync-state.ts";
import { settingsV1ToV2Step, stateV1ToV2Step, journalV1ToV2Step } from "./steps/v1-to-v2.ts";
import { journalV2ToV3Step, stateV2ToV3Step } from "./steps/v2-to-v3.ts";
import { journalV3ToV4Step } from "./steps/v3-to-v4.ts";
export const settingsMigrationChain = defineStateMigrationChain({
  family: "pragma.asset-sync-settings",
  currentVersion: 2,
  currentSchema: CoreAssetSyncConfigurationSchema,
  steps: [settingsV1ToV2Step],
});
export const stateMigrationChain = defineStateMigrationChain({
  family: "pragma.asset-sync-state",
  currentVersion: 3,
  currentSchema: StateSchema,
  steps: [stateV1ToV2Step, stateV2ToV3Step],
});
export const journalMigrationChain = defineStateMigrationChain({
  family: "pragma.asset-sync-journal",
  currentVersion: 4,
  currentSchema: JournalSchema,
  steps: [journalV1ToV2Step, journalV2ToV3Step, journalV3ToV4Step],
});
