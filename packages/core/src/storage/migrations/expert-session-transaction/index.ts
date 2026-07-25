import { defineStateMigrationChain } from "../../state-migration.ts";
import { expertSessionTransactionV4ToV5Step } from "./steps/v4-to-v5.ts";
import { expertSessionTransactionV5ToV6Step } from "./steps/v5-to-v6.ts";
import {
  ExpertSessionTransactionJournalV6Schema,
  type ExpertSessionTransactionJournalV6,
} from "./schemas/v6.ts";

export {
  ExpertSessionTransactionJournalV6Schema as ExpertSessionTransactionJournalSchema,
  type ExpertSessionTransactionJournalV6 as ExpertSessionTransactionJournal,
} from "./schemas/v6.ts";

export const expertSessionTransactionMigrationChain =
  defineStateMigrationChain<ExpertSessionTransactionJournalV6>({
    family: "pragma.expert-session-transaction",
    currentVersion: 6,
    currentSchema: ExpertSessionTransactionJournalV6Schema,
    steps: [expertSessionTransactionV4ToV5Step, expertSessionTransactionV5ToV6Step],
  });
