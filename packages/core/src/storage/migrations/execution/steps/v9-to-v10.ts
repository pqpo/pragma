import { InvocationSchema, type Invocation } from "@pragma/shared";

import type { StateMigrationStep } from "../../../state-migration.ts";
import { InvocationV9Schema } from "../schemas/invocation-v9.ts";
import { ExecutionRecordV9Schema } from "../schemas/v9.ts";
import { ExecutionRecordV10Schema } from "../schemas/v10.ts";

export const executionV9ToV10Step = {
  fromVersion: 9,
  toVersion: 10,
  inputSchema: ExecutionRecordV9Schema,
  migrate(value) {
    const current = ExecutionRecordV9Schema.parse(value);
    return ExecutionRecordV10Schema.parse({
      ...current,
      schemaVersion: "pragma.execution/v10",
    });
  },
} satisfies StateMigrationStep;

export function migrateExecutionInvocationsV9ToV10(value: unknown): Invocation[] {
  return InvocationV9Schema.array()
    .parse(value)
    .map((invocation) =>
      InvocationSchema.parse({
        ...invocation,
        pendingExpertMessages: [],
      }),
    );
}
