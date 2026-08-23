import { defineStateMigrationChain } from "../../state-migration.ts";
import { expertSessionTransactionV4ToV5Step } from "./steps/v4-to-v5.ts";
import { expertSessionTransactionV5ToV6Step } from "./steps/v5-to-v6.ts";
import { expertSessionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { expertSessionTransactionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { expertSessionTransactionV8ToV9Step } from "./steps/v8-to-v9.ts";
import {
  ExpertSessionTransactionJournalV9Schema,
  type ExpertSessionTransactionJournalV9,
} from "./schemas/v9.ts";

export {
  ExpertSessionTransactionJournalV9Schema as ExpertSessionTransactionJournalSchema,
  type ExpertSessionTransactionJournalV9 as ExpertSessionTransactionJournal,
} from "./schemas/v9.ts";

export const expertSessionTransactionMigrationChain =
  defineStateMigrationChain<ExpertSessionTransactionJournalV9>({
    family: "pragma.expert-session-transaction",
    currentVersion: 9,
    currentSchema: ExpertSessionTransactionJournalV9Schema,
    steps: [
      expertSessionTransactionV4ToV5Step,
      expertSessionTransactionV5ToV6Step,
      expertSessionTransactionV6ToV7Step,
      expertSessionTransactionV7ToV8Step,
      expertSessionTransactionV8ToV9Step,
    ],
  });
