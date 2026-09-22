import { defineStateMigrationChain } from "../../state-migration.ts";
import { executionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { executionTransactionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { executionTransactionV8ToV9Step } from "./steps/v8-to-v9.ts";
import { executionTransactionV9ToV10Step } from "./steps/v9-to-v10.ts";
import { executionTransactionV10ToV11Step } from "./steps/v10-to-v11.ts";
import { executionTransactionV11ToV12Step } from "./steps/v11-to-v12.ts";
import { executionTransactionV12ToV13Step } from "./steps/v12-to-v13.ts";
import { ExecutionCommitJournalV13Schema, type ExecutionCommitJournalV13 } from "./schemas/v13.ts";

export {
  ExecutionCommitJournalV13Schema as ExecutionCommitJournalSchema,
  type ExecutionCommitJournalV13 as ExecutionCommitJournal,
} from "./schemas/v13.ts";

export const executionCommitJournalMigrationChain =
  defineStateMigrationChain<ExecutionCommitJournalV13>({
    family: "pragma.execution-transaction",
    currentVersion: 13,
    currentSchema: ExecutionCommitJournalV13Schema,
    steps: [
      executionTransactionV6ToV7Step,
      executionTransactionV7ToV8Step,
      executionTransactionV8ToV9Step,
      executionTransactionV9ToV10Step,
      executionTransactionV10ToV11Step,
      executionTransactionV11ToV12Step,
      executionTransactionV12ToV13Step,
    ],
  });
