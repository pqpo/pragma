import { ExpertSessionEventSchema, InvocationSchema, PromptRequestSchema } from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV9Schema } from "../../execution/schemas/v9.ts";
import { ExpertSessionRecordV5Schema } from "../../expert-session/schemas/v5.ts";

export const ExpertSessionTransactionJournalV8Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v8"),
    session: ExpertSessionRecordV5Schema,
    prompts: PromptRequestSchema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordV9Schema.optional(),
    rootInvocation: InvocationSchema.optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  );

export type ExpertSessionTransactionJournalV8 = z.infer<
  typeof ExpertSessionTransactionJournalV8Schema
>;
