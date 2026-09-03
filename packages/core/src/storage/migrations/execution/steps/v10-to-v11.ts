import { ExpertPromptInputSchema, InvocationSchema, type Invocation } from "@pragma/shared";

import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExecutionRecordV10Schema } from "../schemas/v10.ts";
import { ExecutionRecordV11Schema, type ExecutionRecordV11 } from "../schemas/v11.ts";

export const executionV10ToV11Step = {
  fromVersion: 10,
  toVersion: 11,
  inputSchema: ExecutionRecordV10Schema,
  migrate(value) {
    const current = ExecutionRecordV10Schema.parse(value);
    return ExecutionRecordV11Schema.parse({
      ...current,
      schemaVersion: "pragma.execution/v11",
      input:
        current.kind === "expert-turn" && typeof current.input === "string"
          ? ExpertPromptInputSchema.parse({ text: current.input, attachments: [] })
          : current.input,
    });
  },
} satisfies StateMigrationStep;

export function migrateExecutionInvocationsV10ToV11(
  execution: ExecutionRecordV11,
  value: unknown,
): Invocation[] {
  return InvocationSchema.array()
    .parse(value)
    .map((invocation) =>
      execution.kind === "expert-turn" &&
      invocation.invocationId === execution.rootInvocationId &&
      typeof invocation.input === "string"
        ? InvocationSchema.parse({
            ...invocation,
            input: ExpertPromptInputSchema.parse({ text: invocation.input, attachments: [] }),
          })
        : invocation,
    );
}
