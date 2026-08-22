import { AgentMessageUsageSchema, InvocationOutputSchema } from "@pragma/shared";
import { z } from "zod";

export const ExecutionRecordV10Schema = z.object({
  schemaVersion: z.literal("pragma.execution/v10"),
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
});

export type ExecutionRecordV10 = z.infer<typeof ExecutionRecordV10Schema>;
