import type { StateMigrationStep } from "../../../state-migration.ts";
import { expertSessionV5ToV6Step } from "../../expert-session/steps/v5-to-v6.ts";
import { migratePromptPurposes } from "../../expert-session/steps/prompt-purpose.ts";
import { ExpertSessionTransactionJournalV10Schema } from "../schemas/v10.ts";
import { ExpertSessionTransactionJournalV9Schema } from "../schemas/v9.ts";

export const expertSessionTransactionV9ToV10Step = {
  fromVersion: 9,
  toVersion: 10,
  inputSchema: ExpertSessionTransactionJournalV9Schema,
  migrate(value) {
    const current = ExpertSessionTransactionJournalV9Schema.parse(value);
    return ExpertSessionTransactionJournalV10Schema.parse({
      ...current,
      schemaVersion: "pragma.expert-session-transaction/v10",
      session: expertSessionV5ToV6Step.migrate(current.session),
      prompts: migratePromptPurposes(current.prompts, current.events),
    });
  },
} satisfies StateMigrationStep;
