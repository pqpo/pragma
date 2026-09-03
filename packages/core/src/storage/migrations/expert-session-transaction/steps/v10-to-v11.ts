import type { StateMigrationStep } from "../../../state-migration.ts";
import {
  executionV10ToV11Step,
  migrateExecutionInvocationsV10ToV11,
} from "../../execution/steps/v10-to-v11.ts";
import { expertSessionV6ToV7Step } from "../../expert-session/steps/v6-to-v7.ts";
import { migrateQueueSteerDeliveryAttempts } from "../../expert-session/steps/queue-steer-delivery.ts";
import { ExpertSessionTransactionJournalV10Schema } from "../schemas/v10.ts";
import { ExpertSessionTransactionJournalV11Schema } from "../schemas/v11.ts";

export const expertSessionTransactionV10ToV11Step = {
  fromVersion: 10,
  toVersion: 11,
  inputSchema: ExpertSessionTransactionJournalV10Schema,
  migrate(value) {
    const current = ExpertSessionTransactionJournalV10Schema.parse(value);
    const execution =
      current.execution === undefined
        ? undefined
        : executionV10ToV11Step.migrate(current.execution);
    const rootInvocation =
      execution === undefined || current.rootInvocation === undefined
        ? undefined
        : migrateExecutionInvocationsV10ToV11(execution, [current.rootInvocation])[0];
    return ExpertSessionTransactionJournalV11Schema.parse({
      ...current,
      schemaVersion: "pragma.expert-session-transaction/v11",
      session: expertSessionV6ToV7Step.migrate(current.session),
      prompts: migrateQueueSteerDeliveryAttempts(current.prompts),
      ...(execution === undefined ? {} : { execution, rootInvocation }),
    });
  },
} satisfies StateMigrationStep;
