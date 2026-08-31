import { ExpertSessionEventSchema, InvocationSchema } from "@pragma/shared";
import { z } from "zod";

import { AgentMessageUsageV7Schema, ExecutionRecordV7Schema } from "../../execution/schemas/v7.ts";
import { ExpertSessionRecordV5Schema } from "../../expert-session/schemas/v5.ts";
import { PromptRequestV1Schema } from "../../expert-session/schemas/prompt-request-v1.ts";

export const ExpertSessionTransactionJournalV6Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v6"),
    session: ExpertSessionRecordV5Schema,
    prompts: PromptRequestV1Schema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordV7Schema.optional(),
    rootInvocation: InvocationSchema.extend({
      usage: AgentMessageUsageV7Schema.optional(),
    }).optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  );

export type ExpertSessionTransactionJournalV6 = z.infer<
  typeof ExpertSessionTransactionJournalV6Schema
>;
