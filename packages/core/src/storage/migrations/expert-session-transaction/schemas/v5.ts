import { ExpertSessionEventSchema, InvocationSchema, PromptRequestSchema } from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV6Schema } from "../../execution/schemas/v6.ts";
import { ExpertSessionRecordV4Schema } from "../../expert-session/schemas/v4.ts";

export const ExpertSessionTransactionJournalV5Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v5"),
    session: ExpertSessionRecordV4Schema,
    prompts: PromptRequestSchema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordV6Schema.optional(),
    rootInvocation: InvocationSchema.optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  );

export type ExpertSessionTransactionJournalV5 = z.infer<
  typeof ExpertSessionTransactionJournalV5Schema
>;
