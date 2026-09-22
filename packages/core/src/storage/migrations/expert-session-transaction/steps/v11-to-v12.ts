import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionV11ToV12Step } from "../../execution/steps/v11-to-v12.ts";
import { ExpertSessionTransactionJournalV11Schema } from "../schemas/v11.ts";
import { ExpertSessionTransactionJournalV12Schema } from "../schemas/v12.ts";

export const expertSessionTransactionV11ToV12Step = {
  fromVersion: 11,
  toVersion: 12,
  inputSchema: ExpertSessionTransactionJournalV11Schema,
  migrate(value) {
    const current = ExpertSessionTransactionJournalV11Schema.parse(value);
    return ExpertSessionTransactionJournalV12Schema.parse({
      ...current,
      schemaVersion: "pragma.expert-session-transaction/v12",
      ...(current.execution === undefined
        ? {}
        : { execution: executionV11ToV12Step.migrate(current.execution) }),
    });
  },
} satisfies StateMigrationStep;
