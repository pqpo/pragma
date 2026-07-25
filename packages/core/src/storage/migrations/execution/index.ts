import { ExecutionRecordSchema, type ExecutionRecord } from "@pragma/shared";

import { defineStateMigrationChain } from "../../state-migration.ts";
import { executionV5ToV6Step } from "./steps/v5-to-v6.ts";
import { executionV6ToV7Step } from "./steps/v6-to-v7.ts";

export { ExecutionRecordV5Schema } from "./schemas/v5.ts";
export { ExecutionRecordV6Schema } from "./schemas/v6.ts";
export { ExecutionRecordV7Schema } from "./schemas/v7.ts";
export { migrateExecutionInvocationsV5ToV6 } from "./steps/v5-to-v6.ts";
export { executionV5ToV6Step } from "./steps/v5-to-v6.ts";

export const executionRecordMigrationChain = defineStateMigrationChain<ExecutionRecord>({
  family: "pragma.execution",
  currentVersion: 7,
  currentSchema: ExecutionRecordSchema,
  steps: [executionV5ToV6Step, executionV6ToV7Step],
});
