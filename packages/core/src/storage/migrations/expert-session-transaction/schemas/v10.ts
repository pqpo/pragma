import { ExpertSessionEventSchema, InvocationSchema, PromptRequestSchema } from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV10Schema } from "../../execution/schemas/v10.ts";
import { ExpertSessionRecordV6Schema } from "../../expert-session/schemas/v6.ts";

export const ExpertSessionTransactionJournalV10Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v10"),
    session: ExpertSessionRecordV6Schema,
    prompts: PromptRequestSchema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordV10Schema.optional(),
    rootInvocation: InvocationSchema.optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  );

export type ExpertSessionTransactionJournalV10 = z.infer<
  typeof ExpertSessionTransactionJournalV10Schema
>;
