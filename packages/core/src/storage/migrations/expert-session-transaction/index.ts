import { defineStateMigrationChain } from "../../state-migration.ts";
import {
  ExpertSessionTransactionJournalV5Schema,
  type ExpertSessionTransactionJournalV5,
} from "./schemas/v5.ts";
import { expertSessionTransactionV4ToV5Step } from "./steps/v4-to-v5.ts";

export {
  ExpertSessionTransactionJournalV5Schema as ExpertSessionTransactionJournalSchema,
  type ExpertSessionTransactionJournalV5 as ExpertSessionTransactionJournal,
} from "./schemas/v5.ts";

export const expertSessionTransactionMigrationChain =
  defineStateMigrationChain<ExpertSessionTransactionJournalV5>({
    family: "pragma.expert-session-transaction",
    currentVersion: 5,
    currentSchema: ExpertSessionTransactionJournalV5Schema,
    steps: [expertSessionTransactionV4ToV5Step],
  });
