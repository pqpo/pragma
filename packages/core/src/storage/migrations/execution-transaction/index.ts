import { defineStateMigrationChain } from "../../state-migration.ts";
import { executionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { executionTransactionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { executionTransactionV8ToV9Step } from "./steps/v8-to-v9.ts";
import { ExecutionCommitJournalV9Schema, type ExecutionCommitJournalV9 } from "./schemas/v9.ts";

export {
  ExecutionCommitJournalV9Schema as ExecutionCommitJournalSchema,
  type ExecutionCommitJournalV9 as ExecutionCommitJournal,
} from "./schemas/v9.ts";

export const executionCommitJournalMigrationChain =
  defineStateMigrationChain<ExecutionCommitJournalV9>({
    family: "pragma.execution-transaction",
    currentVersion: 9,
    currentSchema: ExecutionCommitJournalV9Schema,
    steps: [
      executionTransactionV6ToV7Step,
      executionTransactionV7ToV8Step,
      executionTransactionV8ToV9Step,
    ],
  });
