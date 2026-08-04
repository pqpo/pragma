import { defineStateMigrationChain } from "../../state-migration.ts";
import { executionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { executionTransactionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { executionTransactionV8ToV9Step } from "./steps/v8-to-v9.ts";
import { executionTransactionV9ToV10Step } from "./steps/v9-to-v10.ts";
import { ExecutionCommitJournalV10Schema, type ExecutionCommitJournalV10 } from "./schemas/v10.ts";

export {
  ExecutionCommitJournalV10Schema as ExecutionCommitJournalSchema,
  type ExecutionCommitJournalV10 as ExecutionCommitJournal,
} from "./schemas/v10.ts";

export const executionCommitJournalMigrationChain =
  defineStateMigrationChain<ExecutionCommitJournalV10>({
    family: "pragma.execution-transaction",
    currentVersion: 10,
    currentSchema: ExecutionCommitJournalV10Schema,
    steps: [
      executionTransactionV6ToV7Step,
      executionTransactionV7ToV8Step,
      executionTransactionV8ToV9Step,
      executionTransactionV9ToV10Step,
    ],
  });
