import { ExpertSessionRecordSchema, type ExpertSessionRecord } from "@pragma/shared";

import { defineStateMigrationChain } from "../../state-migration.ts";
import { expertSessionV4ToV5Step } from "./steps/v4-to-v5.ts";
import { expertSessionV5ToV6Step } from "./steps/v5-to-v6.ts";

export { ExpertSessionRecordV4Schema } from "./schemas/v4.ts";
export { ExpertSessionRecordV5Schema } from "./schemas/v5.ts";
export { ExpertSessionRecordV6Schema } from "./schemas/v6.ts";

export const expertSessionRecordMigrationChain = defineStateMigrationChain<ExpertSessionRecord>({
  family: "pragma.expert-session",
  currentVersion: 6,
  currentSchema: ExpertSessionRecordSchema,
  steps: [expertSessionV4ToV5Step, expertSessionV5ToV6Step],
});
