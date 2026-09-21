import { defineStateMigrationChain } from "@pragma/core";

import { SkillSyncStateV2Schema, type SkillSyncStateV2 } from "./schemas/v2.ts";
import { skillSyncStateV1ToV2Step } from "./steps/v1-to-v2.ts";

export { SkillSyncStateV1Schema, type SkillSyncStateV1 } from "./schemas/v1.ts";
export {
  PendingSkillRemoteActivationSchema,
  SkillSyncStateV2Schema,
  StoredPortableSkillFilesSchema,
  StoredSkillSyncSummarySchema,
  type SkillSyncStateV2,
} from "./schemas/v2.ts";
export { skillSyncStateV1ToV2Step } from "./steps/v1-to-v2.ts";

export const skillSyncStateMigrationChain = defineStateMigrationChain<SkillSyncStateV2>({
  family: "pragma.skill-sync-state",
  currentVersion: 2,
  currentSchema: SkillSyncStateV2Schema,
  steps: [skillSyncStateV1ToV2Step],
});
