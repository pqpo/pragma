import { ExpertSessionRecordSchema, type ExpertSessionRecord } from "@pragma/shared";

import { defineStateMigrationChain } from "../../state-migration.ts";

export { ExpertSessionRecordV4Schema } from "./schemas/v4.ts";

export const expertSessionRecordMigrationChain = defineStateMigrationChain<ExpertSessionRecord>({
  family: "pragma.expert-session",
  currentVersion: 4,
  currentSchema: ExpertSessionRecordSchema,
});
