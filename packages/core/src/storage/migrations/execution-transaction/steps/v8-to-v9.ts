import type { StateMigrationStep } from "../../../state-migration.ts";
import {
  executionV7ToV8Step,
  migrateInvocationUsageV7ToV8,
} from "../../execution/steps/v7-to-v8.ts";
import { ExecutionCommitJournalV8Schema } from "../schemas/v8.ts";
import { ExecutionCommitJournalV9Schema } from "../schemas/v9.ts";

export const executionTransactionV8ToV9Step = {
  fromVersion: 8,
  toVersion: 9,
  inputSchema: ExecutionCommitJournalV8Schema,
  migrate(value) {
    const current = ExecutionCommitJournalV8Schema.parse(value);
    return ExecutionCommitJournalV9Schema.parse({
      ...current,
      schemaVersion: "pragma.execution-transaction/v9",
      execution: executionV7ToV8Step.migrate(current.execution),
      invocations: current.invocations.map(migrateInvocationUsageV7ToV8),
    });
  },
} satisfies StateMigrationStep;
