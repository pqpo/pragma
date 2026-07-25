import type { StateMigrationStep } from "../../../state-migration.ts";
import {
  executionRecordMigrationChain,
  migrateExecutionInvocationsV5ToV6,
} from "../../execution/index.ts";
import { ExpertSessionTransactionJournalV4Schema } from "../schemas/v4.ts";

export const expertSessionTransactionV4ToV5Step = {
  fromVersion: 4,
  toVersion: 5,
  inputSchema: ExpertSessionTransactionJournalV4Schema,
  migrate(value) {
    const journal = ExpertSessionTransactionJournalV4Schema.parse(value);
    const execution =
      journal.execution === undefined
        ? undefined
        : executionRecordMigrationChain.upgrade(journal.execution).value;
    const rootInvocation =
      journal.rootInvocation === undefined
        ? undefined
        : journal.execution?.schemaVersion === "pragma.execution/v5"
          ? migrateExecutionInvocationsV5ToV6([journal.rootInvocation])[0]
          : journal.rootInvocation;
    return {
      ...journal,
      schemaVersion: "pragma.expert-session-transaction/v5",
      ...(execution === undefined ? {} : { execution }),
      ...(rootInvocation === undefined ? {} : { rootInvocation }),
    };
  },
} satisfies StateMigrationStep;
