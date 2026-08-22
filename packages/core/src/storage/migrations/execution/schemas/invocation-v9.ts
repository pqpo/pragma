import { z } from "zod";

import { AgentMessageUsageV9Schema } from "./shared-v9.ts";

const DefinitionReferenceV9Schema = z.object({
  id: z.string().min(1),
  kind: z.enum(["flow", "task", "human-task", "expert", "expert-team"]),
});

const ContextResolutionRecordV9Schema = z.object({
  resolver: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  disposition: z.enum(["created", "reused"]),
});

export const InvocationV9Schema = z.object({
  invocationId: z.string().min(1),
  rootInvocationId: z.string().min(1),
  parentInvocationId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  definition: DefinitionReferenceV9Schema,
  executorId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  agentTaskSequence: z.number().int().nonnegative().optional(),
  contextId: z.string().min(1),
  contextResolution: ContextResolutionRecordV9Schema.optional(),
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
  output: z.unknown().optional(),
  usage: AgentMessageUsageV9Schema.optional(),
  error: z.unknown().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type InvocationV9 = z.infer<typeof InvocationV9Schema>;
