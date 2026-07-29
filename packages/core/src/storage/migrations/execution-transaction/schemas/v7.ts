import { ExecutionEventSchema, InvocationSchema } from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV6Schema } from "../../execution/schemas/v6.ts";
import { AgentMessageUsageV7Schema } from "../../execution/schemas/v7.ts";
import { RuntimeContextRecordV4Schema } from "../../expert-session/schemas/v4.ts";

const DefinitionReferenceV6Schema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(["expert", "expert-team", "flow", "task", "human-task"]),
});

const InvocationV6Schema = InvocationSchema.extend({
  definition: DefinitionReferenceV6Schema,
  usage: AgentMessageUsageV7Schema.optional(),
});

const AgentInstanceV1DefinitionSchema = z.object({
  schemaVersion: z.literal("pragma.agent-instance/v2"),
  agentId: z.string().min(1),
  executionId: z.string().min(1),
  ownerContextId: z.string().min(1),
  createdByInvocationId: z.string().min(1),
  parentAgentId: z.string().min(1).optional(),
  definition: DefinitionReferenceV6Schema,
  contextId: z.string().min(1),
  lifecycle: z.enum(["open", "closed"]),
  activeInvocationId: z.string().min(1).optional(),
  nextTaskSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});

export const ExecutionCommitJournalV7Schema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v7"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordV6Schema,
  invocations: InvocationV6Schema.array(),
  agents: AgentInstanceV1DefinitionSchema.array(),
  contexts: RuntimeContextRecordV4Schema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

export type ExecutionCommitJournalV7 = z.infer<typeof ExecutionCommitJournalV7Schema>;
