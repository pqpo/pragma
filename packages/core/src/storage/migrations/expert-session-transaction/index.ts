import { defineStateMigrationChain } from "../../state-migration.ts";
import { expertSessionTransactionV4ToV5Step } from "./steps/v4-to-v5.ts";
import { expertSessionTransactionV5ToV6Step } from "./steps/v5-to-v6.ts";
import { expertSessionTransactionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { expertSessionTransactionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { expertSessionTransactionV8ToV9Step } from "./steps/v8-to-v9.ts";
import { expertSessionTransactionV9ToV10Step } from "./steps/v9-to-v10.ts";
import { expertSessionTransactionV10ToV11Step } from "./steps/v10-to-v11.ts";
import {
  ExpertSessionTransactionJournalV11Schema,
  type ExpertSessionTransactionJournalV11,
} from "./schemas/v11.ts";

export {
  ExpertSessionTransactionJournalV11Schema as ExpertSessionTransactionJournalSchema,
  type ExpertSessionTransactionJournalV11 as ExpertSessionTransactionJournal,
} from "./schemas/v11.ts";

export const expertSessionTransactionMigrationChain =
  defineStateMigrationChain<ExpertSessionTransactionJournalV11>({
    family: "pragma.expert-session-transaction",
    currentVersion: 11,
    currentSchema: ExpertSessionTransactionJournalV11Schema,
    steps: [
      expertSessionTransactionV4ToV5Step,
      expertSessionTransactionV5ToV6Step,
      expertSessionTransactionV6ToV7Step,
      expertSessionTransactionV7ToV8Step,
      expertSessionTransactionV8ToV9Step,
      expertSessionTransactionV9ToV10Step,
      expertSessionTransactionV10ToV11Step,
    ],
  });
