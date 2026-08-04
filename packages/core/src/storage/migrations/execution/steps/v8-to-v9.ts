import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExecutionRecordV8Schema } from "../schemas/v8.ts";
import { ExecutionRecordV9Schema } from "../schemas/v9.ts";

export const executionV8ToV9Step = {
  fromVersion: 8,
  toVersion: 9,
  inputSchema: ExecutionRecordV8Schema,
  migrate(value) {
    const current = ExecutionRecordV8Schema.parse(value);
    return ExecutionRecordV9Schema.parse({
      ...current,
      schemaVersion: "pragma.execution/v9",
    });
  },
} satisfies StateMigrationStep;
