import { z } from "zod";

export const AgentMessageUsageV9Schema = z.object({
  measurement: z.enum(["reported", "derived", "estimated", "unknown"]),
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

const ContextOutputReferenceV9Schema = z.object({
  namespace: z.string().min(1),
  id: z.string().min(1),
  revision: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
});

export const InvocationOutputV9Schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), value: z.unknown() }),
  z.object({
    type: z.literal("context"),
    summary: z.string(),
    contexts: z.array(ContextOutputReferenceV9Schema).min(1),
  }),
]);
