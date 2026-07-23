import { InvocationHandoffSchema, InvocationSchema, type Invocation } from "@pragma/shared";

import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExecutionRecordV5Schema } from "../schemas/v5.ts";

export const executionV5ToV6Step = {
  fromVersion: 5,
  toVersion: 6,
  inputSchema: ExecutionRecordV5Schema,
  migrate(value) {
    const record = ExecutionRecordV5Schema.parse(value);
    return {
      ...record,
      schemaVersion: "pragma.execution/v6",
      ...(record.output === undefined ? {} : { output: inlineHandoff(record.output) }),
    };
  },
} satisfies StateMigrationStep;

export function migrateExecutionInvocationsV5ToV6(value: unknown): Invocation[] {
  return InvocationSchema.array()
    .parse(value)
    .map((invocation) => {
      if (
        invocation.output === undefined ||
        invocation.definition.kind === "task" ||
        invocation.definition.kind === "human-task"
      ) {
        return invocation;
      }
      return InvocationSchema.parse({
        ...invocation,
        output: inlineHandoff(invocation.output),
      });
    });
}

function inlineHandoff(value: unknown): ReturnType<typeof InvocationHandoffSchema.parse> {
  return InvocationHandoffSchema.parse({ type: "inline", value });
}
