import { defineStateMigrationChain } from "../../state-migration.ts";
import { executionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { executionTransactionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { executionTransactionV8ToV9Step } from "./steps/v8-to-v9.ts";
import { executionTransactionV9ToV10Step } from "./steps/v9-to-v10.ts";
import { executionTransactionV10ToV11Step } from "./steps/v10-to-v11.ts";
import { ExecutionCommitJournalV11Schema, type ExecutionCommitJournalV11 } from "./schemas/v11.ts";

export {
  ExecutionCommitJournalV11Schema as ExecutionCommitJournalSchema,
  type ExecutionCommitJournalV11 as ExecutionCommitJournal,
} from "./schemas/v11.ts";

export const executionCommitJournalMigrationChain =
  defineStateMigrationChain<ExecutionCommitJournalV11>({
    family: "pragma.execution-transaction",
    currentVersion: 11,
    currentSchema: ExecutionCommitJournalV11Schema,
    steps: [
      executionTransactionV6ToV7Step,
      executionTransactionV7ToV8Step,
      executionTransactionV8ToV9Step,
      executionTransactionV9ToV10Step,
      executionTransactionV10ToV11Step,
    ],
  });
