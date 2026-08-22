import { InvocationSchema } from "@pragma/shared";

import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionV9ToV10Step } from "../../execution/steps/v9-to-v10.ts";
import { ExpertSessionTransactionJournalV8Schema } from "../schemas/v8.ts";
import { ExpertSessionTransactionJournalV9Schema } from "../schemas/v9.ts";

export const expertSessionTransactionV8ToV9Step = {
  fromVersion: 8,
  toVersion: 9,
  inputSchema: ExpertSessionTransactionJournalV8Schema,
  migrate(value) {
    const current = ExpertSessionTransactionJournalV8Schema.parse(value);
    return ExpertSessionTransactionJournalV9Schema.parse({
      ...current,
      schemaVersion: "pragma.expert-session-transaction/v9",
      ...(current.execution === undefined || current.rootInvocation === undefined
        ? {}
        : {
            execution: executionV9ToV10Step.migrate(current.execution),
            rootInvocation: InvocationSchema.parse({
              ...current.rootInvocation,
              pendingExpertMessages: [],
            }),
          }),
    });
  },
} satisfies StateMigrationStep;
