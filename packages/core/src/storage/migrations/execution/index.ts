import { ExecutionRecordSchema, type ExecutionRecord } from "@pragma/shared";

import { defineStateMigrationChain } from "../../state-migration.ts";
import { executionV5ToV6Step } from "./steps/v5-to-v6.ts";
import { executionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { executionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { executionV8ToV9Step } from "./steps/v8-to-v9.ts";

export { ExecutionRecordV5Schema } from "./schemas/v5.ts";
export { ExecutionRecordV6Schema } from "./schemas/v6.ts";
export { ExecutionRecordV7Schema } from "./schemas/v7.ts";
export { ExecutionRecordV8Schema } from "./schemas/v8.ts";
export { ExecutionRecordV9Schema } from "./schemas/v9.ts";
export { migrateExecutionInvocationsV5ToV6 } from "./steps/v5-to-v6.ts";
export { executionV5ToV6Step } from "./steps/v5-to-v6.ts";
export { migrateInvocationUsageV7ToV8 } from "./steps/v7-to-v8.ts";

export const executionRecordMigrationChain = defineStateMigrationChain<ExecutionRecord>({
  family: "pragma.execution",
  currentVersion: 9,
  currentSchema: ExecutionRecordSchema,
  steps: [executionV5ToV6Step, executionV6ToV7Step, executionV7ToV8Step, executionV8ToV9Step],
});
