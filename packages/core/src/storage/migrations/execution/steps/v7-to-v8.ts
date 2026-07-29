import type { StateMigrationStep } from "../../../state-migration.ts";
import { InvocationSchema } from "@pragma/shared";
import { ExecutionRecordV7Schema } from "../schemas/v7.ts";
import { ExecutionRecordV8Schema } from "../schemas/v8.ts";

export const executionV7ToV8Step = {
  fromVersion: 7,
  toVersion: 8,
  inputSchema: ExecutionRecordV7Schema,
  migrate(value) {
    const current = ExecutionRecordV7Schema.parse(value);
    return ExecutionRecordV8Schema.parse({
      ...current,
      schemaVersion: "pragma.execution/v8",
      ...(current.usage === undefined
        ? {}
        : { usage: { measurement: "unknown", ...current.usage } }),
    });
  },
} satisfies StateMigrationStep;

export function migrateInvocationUsageV7ToV8(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const invocation = value as Record<string, unknown>;
  const usage = invocation["usage"];
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return value;
  }
  const usageRecord = usage as Record<string, unknown>;
  return InvocationSchema.parse({
    ...invocation,
    usage:
      typeof usageRecord["measurement"] === "string"
        ? usage
        : { measurement: "unknown", ...usageRecord },
  });
}
