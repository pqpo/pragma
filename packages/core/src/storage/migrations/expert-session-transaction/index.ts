import { defineStateMigrationChain } from "../../state-migration.ts";
import { expertSessionTransactionV4ToV5Step } from "./steps/v4-to-v5.ts";
import { expertSessionTransactionV5ToV6Step } from "./steps/v5-to-v6.ts";
import { expertSessionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import {
  ExpertSessionTransactionJournalV7Schema,
  type ExpertSessionTransactionJournalV7,
} from "./schemas/v7.ts";

export {
  ExpertSessionTransactionJournalV7Schema as ExpertSessionTransactionJournalSchema,
  type ExpertSessionTransactionJournalV7 as ExpertSessionTransactionJournal,
} from "./schemas/v7.ts";

export const expertSessionTransactionMigrationChain =
  defineStateMigrationChain<ExpertSessionTransactionJournalV7>({
    family: "pragma.expert-session-transaction",
    currentVersion: 7,
    currentSchema: ExpertSessionTransactionJournalV7Schema,
    steps: [
      expertSessionTransactionV4ToV5Step,
      expertSessionTransactionV5ToV6Step,
      expertSessionTransactionV6ToV7Step,
    ],
  });
