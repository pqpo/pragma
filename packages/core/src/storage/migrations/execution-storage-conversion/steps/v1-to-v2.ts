import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExecutionStorageConversionV1Schema } from "../schemas/v1.ts";
import { ExecutionStorageConversionSchema } from "../schemas/v2.ts";
export const executionStorageConversionV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: ExecutionStorageConversionV1Schema,
  migrate(value) {
    const original = ExecutionStorageConversionV1Schema.parse(value);
    return ExecutionStorageConversionSchema.parse({
      ...original,
      schemaVersion: "pragma.execution-storage-conversion/v2",
      phase: original.handoffNames === undefined ? "backup" : "publish",
      importedEvents: 0,
    });
  },
} satisfies StateMigrationStep;
