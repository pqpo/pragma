import { ExecutionEventSchema, InvocationSchema } from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV5Schema } from "../../execution/schemas/v5.ts";
import { AgentMessageUsageV7Schema } from "../../execution/schemas/v7.ts";
import { RuntimeContextRecordV4Schema } from "../../expert-session/schemas/v4.ts";

const DefinitionReferenceV5Schema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(["expert", "expert-team", "flow", "task", "human-task"]),
});

const InvocationV5Schema = InvocationSchema.omit({
  definition: true,
  output: true,
}).extend({
  definition: DefinitionReferenceV5Schema,
  output: z.unknown().optional(),
  usage: AgentMessageUsageV7Schema.optional(),
});

const AgentInstanceV1Schema = z.object({
  schemaVersion: z.literal("pragma.agent-instance/v2"),
  agentId: z.string().min(1),
  executionId: z.string().min(1),
  ownerContextId: z.string().min(1),
  createdByInvocationId: z.string().min(1),
  parentAgentId: z.string().min(1).optional(),
  definition: DefinitionReferenceV5Schema,
  contextId: z.string().min(1),
  lifecycle: z.enum(["open", "closed"]),
  activeInvocationId: z.string().min(1).optional(),
  nextTaskSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});

export const ExecutionCommitJournalV6Schema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v6"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordV5Schema,
  invocations: InvocationV5Schema.array(),
  agents: AgentInstanceV1Schema.array(),
  contexts: RuntimeContextRecordV4Schema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

export type ExecutionCommitJournalV6 = z.infer<typeof ExecutionCommitJournalV6Schema>;
