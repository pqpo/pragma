import { z } from "zod";

const AgentMessageUsageV5Schema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative(),
  cost: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

export const ExecutionRecordV5Schema = z.object({
  schemaVersion: z.literal("pragma.execution/v5"),
  executionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  kind: z.enum(["expert-turn", "flow"]),
  definition: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
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
  output: z.unknown().optional(),
  usage: AgentMessageUsageV5Schema.optional(),
  error: z.unknown().optional(),
  lastAppliedSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ExecutionRecordV5 = z.infer<typeof ExecutionRecordV5Schema>;
