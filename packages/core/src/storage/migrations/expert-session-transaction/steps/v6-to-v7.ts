import type { StateMigrationStep } from "../../../state-migration.ts";
import {
  executionV7ToV8Step,
  migrateInvocationUsageV7ToV8,
} from "../../execution/steps/v7-to-v8.ts";
import { ExpertSessionTransactionJournalV6Schema } from "../schemas/v6.ts";
import { ExpertSessionTransactionJournalV7Schema } from "../schemas/v7.ts";

export const expertSessionTransactionV6ToV7Step = {
  fromVersion: 6,
  toVersion: 7,
  inputSchema: ExpertSessionTransactionJournalV6Schema,
  migrate(value) {
    const current = ExpertSessionTransactionJournalV6Schema.parse(value);
    return ExpertSessionTransactionJournalV7Schema.parse({
      ...current,
      schemaVersion: "pragma.expert-session-transaction/v7",
      ...(current.execution === undefined
        ? {}
        : {
            execution: executionV7ToV8Step.migrate(current.execution),
            rootInvocation: migrateInvocationUsageV7ToV8(current.rootInvocation),
          }),
    });
  },
} satisfies StateMigrationStep;
