import { ExpertSessionEventSchema, InvocationSchema } from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV6Schema } from "../../execution/schemas/v6.ts";
import { ExpertSessionRecordV4Schema } from "../../expert-session/schemas/v4.ts";
import { PromptRequestV1Schema } from "../../expert-session/schemas/prompt-request-v1.ts";

const InvocationV6Schema = InvocationSchema.extend({
  definition: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    kind: z.enum(["expert", "expert-team", "flow", "task", "human-task"]),
  }),
});

export const ExpertSessionTransactionJournalV5Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v5"),
    session: ExpertSessionRecordV4Schema,
    prompts: PromptRequestV1Schema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordV6Schema.optional(),
    rootInvocation: InvocationV6Schema.optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  );

export type ExpertSessionTransactionJournalV5 = z.infer<
  typeof ExpertSessionTransactionJournalV5Schema
>;
