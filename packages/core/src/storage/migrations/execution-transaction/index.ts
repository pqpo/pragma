import { defineStateMigrationChain } from "../../state-migration.ts";
import { ExecutionCommitJournalV7Schema, type ExecutionCommitJournalV7 } from "./schemas/v7.ts";
import { executionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";

export {
  ExecutionCommitJournalV7Schema as ExecutionCommitJournalSchema,
  type ExecutionCommitJournalV7 as ExecutionCommitJournal,
} from "./schemas/v7.ts";

export const executionCommitJournalMigrationChain =
  defineStateMigrationChain<ExecutionCommitJournalV7>({
    family: "pragma.execution-transaction",
    currentVersion: 7,
    currentSchema: ExecutionCommitJournalV7Schema,
    steps: [executionTransactionV6ToV7Step],
  });
