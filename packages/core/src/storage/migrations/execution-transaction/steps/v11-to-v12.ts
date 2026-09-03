import type { StateMigrationStep } from "../../../state-migration.ts";
import {
  executionV10ToV11Step,
  migrateExecutionInvocationsV10ToV11,
} from "../../execution/steps/v10-to-v11.ts";
import { ExecutionCommitJournalV11Schema } from "../schemas/v11.ts";
import { ExecutionCommitJournalV12Schema } from "../schemas/v12.ts";

export const executionTransactionV11ToV12Step = {
  fromVersion: 11,
  toVersion: 12,
  inputSchema: ExecutionCommitJournalV11Schema,
  migrate(value) {
    const current = ExecutionCommitJournalV11Schema.parse(value);
    const execution = executionV10ToV11Step.migrate(current.execution);
    return ExecutionCommitJournalV12Schema.parse({
      ...current,
      schemaVersion: "pragma.execution-transaction/v12",
      execution,
      invocations: migrateExecutionInvocationsV10ToV11(execution, current.invocations),
    });
  },
} satisfies StateMigrationStep;
