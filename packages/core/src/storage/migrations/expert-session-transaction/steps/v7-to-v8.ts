import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionV8ToV9Step } from "../../execution/steps/v8-to-v9.ts";
import { ExpertSessionTransactionJournalV7Schema } from "../schemas/v7.ts";
import { ExpertSessionTransactionJournalV8Schema } from "../schemas/v8.ts";

export const expertSessionTransactionV7ToV8Step = {
  fromVersion: 7,
  toVersion: 8,
  inputSchema: ExpertSessionTransactionJournalV7Schema,
  migrate(value) {
    const current = ExpertSessionTransactionJournalV7Schema.parse(value);
    return ExpertSessionTransactionJournalV8Schema.parse({
      ...current,
      schemaVersion: "pragma.expert-session-transaction/v8",
      ...(current.execution === undefined
        ? {}
        : { execution: executionV8ToV9Step.migrate(current.execution) }),
    });
  },
} satisfies StateMigrationStep;
