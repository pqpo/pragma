import { defineStateMigrationChain } from "../../state-migration.ts";
import { executionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { executionTransactionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { ExecutionCommitJournalV8Schema, type ExecutionCommitJournalV8 } from "./schemas/v8.ts";

export {
  ExecutionCommitJournalV8Schema as ExecutionCommitJournalSchema,
  type ExecutionCommitJournalV8 as ExecutionCommitJournal,
} from "./schemas/v8.ts";

export const executionCommitJournalMigrationChain =
  defineStateMigrationChain<ExecutionCommitJournalV8>({
    family: "pragma.execution-transaction",
    currentVersion: 8,
    currentSchema: ExecutionCommitJournalV8Schema,
    steps: [executionTransactionV6ToV7Step, executionTransactionV7ToV8Step],
  });
