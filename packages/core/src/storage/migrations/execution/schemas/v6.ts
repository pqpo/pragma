import { z } from "zod";

const AgentMessageUsageV6Schema = z.object({
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

const InvocationHandoffV6Schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inline"),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal("context"),
    summary: z.string(),
    contexts: z
      .array(
        z.object({
          namespace: z.literal("pragma.handoff"),
          id: z.string().min(1),
          revision: z.string().min(1),
          sizeBytes: z.number().int().nonnegative(),
          mediaType: z.string().min(1),
        }),
      )
      .min(1),
  }),
]);

export const ExecutionRecordV6Schema = z.object({
  schemaVersion: z.literal("pragma.execution/v6"),
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
  output: InvocationHandoffV6Schema.optional(),
  usage: AgentMessageUsageV6Schema.optional(),
  error: z.unknown().optional(),
  lastAppliedSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ExecutionRecordV6 = z.infer<typeof ExecutionRecordV6Schema>;
