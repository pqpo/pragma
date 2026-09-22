import {
  ExpertPromptInputSchema,
  ExpertSessionEventSchema,
  InvocationSchema,
  PromptRequestSchema,
} from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV12Schema } from "../../execution/schemas/v12.ts";
import { ExpertSessionRecordV7Schema } from "../../expert-session/schemas/v7.ts";

export const ExpertSessionTransactionJournalV12Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v12"),
    session: ExpertSessionRecordV7Schema,
    prompts: PromptRequestSchema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordV12Schema.optional(),
    rootInvocation: InvocationSchema.optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  )
  .superRefine((journal, context) => {
    if (
      journal.execution?.kind === "expert-turn" &&
      (journal.rootInvocation === undefined ||
        !ExpertPromptInputSchema.safeParse(journal.rootInvocation.input).success)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rootInvocation", "input"],
        message: "Expert turn root Invocation input must be a structured Expert prompt.",
      });
    }
  });

export type ExpertSessionTransactionJournalV12 = z.infer<
  typeof ExpertSessionTransactionJournalV12Schema
>;
