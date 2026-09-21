import { defineStateMigrationChain } from "@pragma/core";

import { KnowledgeSyncStateV2Schema, type KnowledgeSyncStateV2 } from "./schemas/v2.ts";
import { knowledgeSyncStateV1ToV2Step } from "./steps/v1-to-v2.ts";

export { KnowledgeSyncStateV1Schema, type KnowledgeSyncStateV1 } from "./schemas/v1.ts";
export {
  KnowledgeSyncStateV2Schema,
  StoredKnowledgeSyncSummarySchema,
  type KnowledgeSyncStateV2,
} from "./schemas/v2.ts";
export { knowledgeSyncStateV1ToV2Step } from "./steps/v1-to-v2.ts";

export const knowledgeSyncStateMigrationChain = defineStateMigrationChain<KnowledgeSyncStateV2>({
  family: "pragma.knowledge-sync-state",
  currentVersion: 2,
  currentSchema: KnowledgeSyncStateV2Schema,
  steps: [knowledgeSyncStateV1ToV2Step],
});
