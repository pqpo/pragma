import { defineStateMigrationChain } from "@pragma/core";
import { MissionDeletionRecordV2Schema, type MissionDeletionRecordV2 } from "./schemas/v2.ts";
import { missionDeletionV1ToV2 } from "./steps/v1-to-v2.ts";
export {
  MissionDeletionRecordV2Schema as MissionDeletionRecordSchema,
  type MissionDeletionRecordV2 as MissionDeletionRecord,
} from "./schemas/v2.ts";
export const missionDeletionMigrationChain = defineStateMigrationChain<MissionDeletionRecordV2>({
  family: "pragma.mission-deletion",
  currentVersion: 2,
  currentSchema: MissionDeletionRecordV2Schema,
  steps: [missionDeletionV1ToV2],
});
