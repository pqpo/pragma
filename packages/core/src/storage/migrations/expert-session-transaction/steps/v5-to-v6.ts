import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionRecordMigrationChain } from "../../execution/index.ts";
import { expertSessionRecordMigrationChain } from "../../expert-session/index.ts";
import { ExpertSessionTransactionJournalV5Schema } from "../schemas/v5.ts";
import { ExpertSessionTransactionJournalV6Schema } from "../schemas/v6.ts";

export const expertSessionTransactionV5ToV6Step = {
  fromVersion: 5,
  toVersion: 6,
  inputSchema: ExpertSessionTransactionJournalV5Schema,
  migrate(value) {
    const journal = ExpertSessionTransactionJournalV5Schema.parse(value);
    const rootInvocation =
      journal.rootInvocation === undefined
        ? undefined
        : {
            ...journal.rootInvocation,
            definition: {
              id: journal.rootInvocation.definition.id,
              kind: journal.rootInvocation.definition.kind,
            },
          };
    return ExpertSessionTransactionJournalV6Schema.parse({
      ...journal,
      schemaVersion: "pragma.expert-session-transaction/v6",
      session: expertSessionRecordMigrationChain.upgrade(journal.session).value,
      ...(journal.execution === undefined
        ? {}
        : { execution: executionRecordMigrationChain.upgrade(journal.execution).value }),
      ...(rootInvocation === undefined ? {} : { rootInvocation }),
    });
  },
} satisfies StateMigrationStep;
