import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExecutionRecordV11Schema } from "../schemas/v11.ts";
import { ExecutionRecordV12Schema } from "../schemas/v12.ts";

export const executionV11ToV12Step = {
  fromVersion: 11,
  toVersion: 12,
  inputSchema: ExecutionRecordV11Schema,
  migrate(value) {
    const current = ExecutionRecordV11Schema.parse(value);
    return ExecutionRecordV12Schema.parse({
      ...current,
      schemaVersion: "pragma.execution/v12",
    });
  },
} satisfies StateMigrationStep;
