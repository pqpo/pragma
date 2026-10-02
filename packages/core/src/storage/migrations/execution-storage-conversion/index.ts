import { defineStateMigrationChain } from "../../state-migration.ts";
import { ExecutionStorageConversionSchema, type ExecutionStorageConversion } from "./schemas/v2.ts";
import { executionStorageConversionV1ToV2Step } from "./steps/v1-to-v2.ts";
export { ExecutionStorageConversionSchema } from "./schemas/v2.ts";
export { ExecutionStorageConversionV1Schema } from "./schemas/v1.ts";
export const executionStorageConversionMigrationChain =
  defineStateMigrationChain<ExecutionStorageConversion>({
    family: "pragma.execution-storage-conversion",
    currentVersion: 2,
    currentSchema: ExecutionStorageConversionSchema,
    steps: [executionStorageConversionV1ToV2Step],
  });
