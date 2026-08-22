import { InvocationSchema } from "@pragma/shared";

import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionV9ToV10Step } from "../../execution/steps/v9-to-v10.ts";
import { ExecutionCommitJournalV10Schema } from "../schemas/v10.ts";
import { ExecutionCommitJournalV11Schema } from "../schemas/v11.ts";

export const executionTransactionV10ToV11Step = {
  fromVersion: 10,
  toVersion: 11,
  inputSchema: ExecutionCommitJournalV10Schema,
  migrate(value) {
    const current = ExecutionCommitJournalV10Schema.parse(value);
    return ExecutionCommitJournalV11Schema.parse({
      ...current,
      schemaVersion: "pragma.execution-transaction/v11",
      execution: executionV9ToV10Step.migrate(current.execution),
      invocations: current.invocations.map((invocation) =>
        InvocationSchema.parse({ ...invocation, pendingExpertMessages: [] }),
      ),
    });
  },
} satisfies StateMigrationStep;
