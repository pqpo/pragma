import type { StateMigrationStep } from "../../../state-migration.ts";
import { executionRecordMigrationChain } from "../../execution/index.ts";
import { ExecutionCommitJournalV7Schema } from "../schemas/v7.ts";
import { ExecutionCommitJournalV8Schema } from "../schemas/v8.ts";

export const executionTransactionV7ToV8Step = {
  fromVersion: 7,
  toVersion: 8,
  inputSchema: ExecutionCommitJournalV7Schema,
  migrate(value) {
    const journal = ExecutionCommitJournalV7Schema.parse(value);
    return ExecutionCommitJournalV8Schema.parse({
      ...journal,
      schemaVersion: "pragma.execution-transaction/v8",
      execution: executionRecordMigrationChain.upgrade(journal.execution).value,
      invocations: journal.invocations.map((invocation) => ({
        ...invocation,
        definition: {
          id: invocation.definition.id,
          kind: invocation.definition.kind,
        },
      })),
      agents: journal.agents.map((agent) => ({
        ...agent,
        definition: {
          id: agent.definition.id,
          kind: agent.definition.kind,
        },
      })),
      contexts: journal.contexts.map((context) => ({
        ...context,
        schemaVersion: "pragma.runtime-context/v5",
        expert: { id: context.expert.id },
      })),
    });
  },
} satisfies StateMigrationStep;
