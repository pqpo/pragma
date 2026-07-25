import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExecutionRecordV6Schema } from "../schemas/v6.ts";
import { ExecutionRecordV7Schema } from "../schemas/v7.ts";

export const executionV6ToV7Step = {
  fromVersion: 6,
  toVersion: 7,
  inputSchema: ExecutionRecordV6Schema,
  migrate(value) {
    const current = ExecutionRecordV6Schema.parse(value);
    const { version: _definitionVersion, ...definition } = current.definition;
    void _definitionVersion;
    return ExecutionRecordV7Schema.parse({
      ...current,
      schemaVersion: "pragma.execution/v7",
      definition,
    });
  },
} satisfies StateMigrationStep;
