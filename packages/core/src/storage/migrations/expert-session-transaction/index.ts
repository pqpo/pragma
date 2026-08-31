import { defineStateMigrationChain } from "../../state-migration.ts";
import { expertSessionTransactionV4ToV5Step } from "./steps/v4-to-v5.ts";
import { expertSessionTransactionV5ToV6Step } from "./steps/v5-to-v6.ts";
import { expertSessionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { expertSessionTransactionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { expertSessionTransactionV8ToV9Step } from "./steps/v8-to-v9.ts";
import { expertSessionTransactionV9ToV10Step } from "./steps/v9-to-v10.ts";
import {
  ExpertSessionTransactionJournalV10Schema,
  type ExpertSessionTransactionJournalV10,
} from "./schemas/v10.ts";

export {
  ExpertSessionTransactionJournalV10Schema as ExpertSessionTransactionJournalSchema,
  type ExpertSessionTransactionJournalV10 as ExpertSessionTransactionJournal,
} from "./schemas/v10.ts";

export const expertSessionTransactionMigrationChain =
  defineStateMigrationChain<ExpertSessionTransactionJournalV10>({
    family: "pragma.expert-session-transaction",
    currentVersion: 10,
    currentSchema: ExpertSessionTransactionJournalV10Schema,
    steps: [
      expertSessionTransactionV4ToV5Step,
      expertSessionTransactionV5ToV6Step,
      expertSessionTransactionV6ToV7Step,
      expertSessionTransactionV7ToV8Step,
      expertSessionTransactionV8ToV9Step,
      expertSessionTransactionV9ToV10Step,
    ],
  });
