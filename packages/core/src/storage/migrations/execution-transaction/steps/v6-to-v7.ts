import type { StateMigrationStep } from "../../../state-migration.ts";
import {
  executionRecordMigrationChain,
  migrateExecutionInvocationsV5ToV6,
} from "../../execution/index.ts";
import { ExecutionCommitJournalV6Schema } from "../schemas/v6.ts";

export const executionTransactionV6ToV7Step = {
  fromVersion: 6,
  toVersion: 7,
  inputSchema: ExecutionCommitJournalV6Schema,
  migrate(value) {
    const journal = ExecutionCommitJournalV6Schema.parse(value);
    return {
      ...journal,
      schemaVersion: "pragma.execution-transaction/v7",
      execution: executionRecordMigrationChain.upgrade(journal.execution).value,
      invocations: migrateExecutionInvocationsV5ToV6(journal.invocations),
    };
  },
} satisfies StateMigrationStep;
