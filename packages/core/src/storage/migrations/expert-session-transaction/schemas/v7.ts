import { ExpertSessionEventSchema, InvocationSchema } from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV8Schema } from "../../execution/schemas/v8.ts";
import { ExpertSessionRecordV5Schema } from "../../expert-session/schemas/v5.ts";
import { PromptRequestV1Schema } from "../../expert-session/schemas/prompt-request-v1.ts";

export const ExpertSessionTransactionJournalV7Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v7"),
    session: ExpertSessionRecordV5Schema,
    prompts: PromptRequestV1Schema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordV8Schema.optional(),
    rootInvocation: InvocationSchema.optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  );

export type ExpertSessionTransactionJournalV7 = z.infer<
  typeof ExpertSessionTransactionJournalV7Schema
>;
