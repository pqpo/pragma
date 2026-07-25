import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionV5ToV6Step } from "../../execution/index.ts";
import { ExecutionCommitJournalV6Schema } from "../schemas/v6.ts";

export const executionTransactionV6ToV7Step = {
  fromVersion: 6,
  toVersion: 7,
  inputSchema: ExecutionCommitJournalV6Schema,
  migrate(value) {
    const journal = ExecutionCommitJournalV6Schema.parse(value);
    return {
      ...journal,
      schemaVersion: "pragma.execution-transaction/v7",
      execution: executionV5ToV6Step.migrate(journal.execution),
      invocations: journal.invocations.map((invocation) => ({
        ...invocation,
        ...(invocation.output === undefined ||
        invocation.definition.kind === "task" ||
        invocation.definition.kind === "human-task"
          ? {}
          : { output: { type: "inline" as const, value: invocation.output } }),
      })),
    };
  },
} satisfies StateMigrationStep;
