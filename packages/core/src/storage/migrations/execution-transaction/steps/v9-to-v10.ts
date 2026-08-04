import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionV8ToV9Step } from "../../execution/steps/v8-to-v9.ts";
import { ExecutionCommitJournalV9Schema } from "../schemas/v9.ts";
import { ExecutionCommitJournalV10Schema } from "../schemas/v10.ts";

export const executionTransactionV9ToV10Step = {
  fromVersion: 9,
  toVersion: 10,
  inputSchema: ExecutionCommitJournalV9Schema,
  migrate(value) {
    const current = ExecutionCommitJournalV9Schema.parse(value);
    return ExecutionCommitJournalV10Schema.parse({
      ...current,
      schemaVersion: "pragma.execution-transaction/v10",
      execution: executionV8ToV9Step.migrate(current.execution),
    });
  },
} satisfies StateMigrationStep;
