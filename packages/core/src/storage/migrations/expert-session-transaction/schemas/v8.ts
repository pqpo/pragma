import { ExpertSessionEventSchema } from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV9Schema } from "../../execution/schemas/v9.ts";
import { InvocationV9Schema } from "../../execution/schemas/invocation-v9.ts";
import { ExpertSessionRecordV5Schema } from "../../expert-session/schemas/v5.ts";
import { PromptRequestV1Schema } from "../../expert-session/schemas/prompt-request-v1.ts";

export const ExpertSessionTransactionJournalV8Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v8"),
    session: ExpertSessionRecordV5Schema,
    prompts: PromptRequestV1Schema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordV9Schema.optional(),
    rootInvocation: InvocationV9Schema.optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  );

export type ExpertSessionTransactionJournalV8 = z.infer<
  typeof ExpertSessionTransactionJournalV8Schema
>;
