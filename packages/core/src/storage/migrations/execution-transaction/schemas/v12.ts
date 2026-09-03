import {
  AgentInstanceSchema,
  ExecutionEventSchema,
  ExpertPromptInputSchema,
  InvocationSchema,
  RuntimeContextRecordSchema,
} from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV11Schema } from "../../execution/schemas/v11.ts";

export const ExecutionCommitJournalV12Schema = z
  .object({
    schemaVersion: z.literal("pragma.execution-transaction/v12"),
    commitId: z.string().min(1),
    signature: z.string().length(64),
    execution: ExecutionRecordV11Schema,
    invocations: InvocationSchema.array(),
    agents: AgentInstanceSchema.array(),
    contexts: RuntimeContextRecordSchema.array(),
    events: ExecutionEventSchema.array(),
    eventIds: z.array(z.string().min(1)),
  })
  .superRefine((journal, context) => {
    if (journal.execution.kind !== "expert-turn") return;
    const root = journal.invocations.find(
      (invocation) => invocation.invocationId === journal.execution.rootInvocationId,
    );
    if (root === undefined || !ExpertPromptInputSchema.safeParse(root.input).success) {
      context.addIssue({
        code: "custom",
        path: ["invocations"],
        message: "Expert turn root Invocation input must be a structured Expert prompt.",
      });
    }
  });

export type ExecutionCommitJournalV12 = z.infer<typeof ExecutionCommitJournalV12Schema>;
