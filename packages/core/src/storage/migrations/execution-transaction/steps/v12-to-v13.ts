import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionV11ToV12Step } from "../../execution/steps/v11-to-v12.ts";
import { ExecutionCommitJournalV12Schema } from "../schemas/v12.ts";
import { ExecutionCommitJournalV13Schema } from "../schemas/v13.ts";

export const executionTransactionV12ToV13Step = {
  fromVersion: 12,
  toVersion: 13,
  inputSchema: ExecutionCommitJournalV12Schema,
  migrate(value) {
    const current = ExecutionCommitJournalV12Schema.parse(value);
    return ExecutionCommitJournalV13Schema.parse({
      ...current,
      schemaVersion: "pragma.execution-transaction/v13",
      execution: executionV11ToV12Step.migrate(current.execution),
    });
  },
} satisfies StateMigrationStep;
