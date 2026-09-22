import {
  AgentMessageUsageSchema,
  ExpertPromptInputSchema,
  InvocationOutputSchema,
} from "@pragma/shared";
import { z } from "zod";

export const ExecutionRecordV11Schema = z
  .object({
    schemaVersion: z.literal("pragma.execution/v11"),
    executionId: z.string().min(1),
    version: z.number().int().nonnegative(),
    kind: z.enum(["expert-turn", "flow"]),
    definition: z.object({
      id: z.string().min(1),
      kind: z.enum(["flow", "task", "human-task", "expert", "expert-team"]),
    }),
    rootInvocationId: z.string().min(1),
    status: z.enum([
      "queued",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    input: z.unknown(),
    state: z.record(z.string(), z.unknown()).default({}),
    output: InvocationOutputSchema.optional(),
    usage: AgentMessageUsageSchema.optional(),
    error: z.unknown().optional(),
    lastAppliedSequence: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((execution, context) => {
    if (
      execution.kind === "expert-turn" &&
      !ExpertPromptInputSchema.safeParse(execution.input).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["input"],
        message: "Expert turn root input must be a structured Expert prompt.",
      });
    }
  });

export type ExecutionRecordV11 = z.infer<typeof ExecutionRecordV11Schema>;
