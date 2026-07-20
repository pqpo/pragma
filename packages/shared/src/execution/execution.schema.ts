import { z } from "zod";
import { AgentMessageSchema, AgentMessageUsageSchema } from "../agent-message.schema.ts";

export const ExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const RuntimeSessionRefSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});

export const RuntimeEnvironmentBindingSchema = z.object({
  runtimeId: z.string().min(1),
  revision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const RuntimeModelSelectionSchema = z.object({
  model: z.object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
  }),
  thinkingLevel: z.string().trim().min(1).optional(),
});

export const ExecutionKindSchema = z.enum(["expert-turn", "flow"]);

export const InvocationKindSchema = z.enum(["flow", "task", "human-task", "expert", "expert-team"]);

export const DefinitionReferenceSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: InvocationKindSchema,
});

export const RuntimeContextSnapshotSchema = z.object({
  systemSessionId: z.string().min(1),
  runtimeSession: RuntimeSessionRefSchema,
});

export const RuntimeContextOwnerSchema = z.object({
  type: z.enum(["flow-execution", "expert-session"]),
  ownerId: z.string().min(1),
});

export const RuntimeContextOriginSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("expert-session"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("invocation"),
    invocationId: z.string().min(1),
  }),
]);

export const RuntimeContextRecordSchema = z
  .object({
    schemaVersion: z.literal("pragma.runtime-context/v4"),
    contextId: z.string().min(1),
    owner: RuntimeContextOwnerSchema,
    origin: RuntimeContextOriginSchema,
    expert: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
    }),
    runtime: RuntimeEnvironmentBindingSchema,
    modelSelection: RuntimeModelSelectionSchema.optional(),
    snapshot: RuntimeContextSnapshotSchema.optional(),
    lifecycle: z.enum(["open", "closed"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    closedAt: z.string().datetime().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.origin.type === "expert-session" &&
      (value.owner.type !== "expert-session" || value.owner.ownerId !== value.origin.sessionId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "ExpertSession Context origin must match its owner.",
      });
    }
    if (value.owner.type === "flow-execution" && value.origin.type !== "invocation") {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "FlowExecution Context requires an Invocation origin.",
      });
    }
    if (value.lifecycle === "closed" && value.closedAt === undefined) {
      context.addIssue({ code: "custom", path: ["closedAt"], message: "closedAt is required." });
    }
    if (value.lifecycle === "open" && value.closedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "Open Context cannot have closedAt.",
      });
    }
  });

export const ContextResolutionRecordSchema = z.object({
  resolver: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  disposition: z.enum(["created", "reused"]),
});

export const InvocationSchema = z.object({
  invocationId: z.string().min(1),
  rootInvocationId: z.string().min(1),
  parentInvocationId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  definition: DefinitionReferenceSchema,
  executorId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  agentTaskSequence: z.number().int().nonnegative().optional(),
  contextId: z.string().min(1),
  contextResolution: ContextResolutionRecordSchema.optional(),
  status: ExecutionStatusSchema,
  input: z.unknown(),
  output: z.unknown().optional(),
  usage: AgentMessageUsageSchema.optional(),
  error: z.unknown().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const AgentInstanceSchema = z.object({
  schemaVersion: z.literal("pragma.agent-instance/v2"),
  agentId: z.string().min(1),
  executionId: z.string().min(1),
  ownerContextId: z.string().min(1),
  createdByInvocationId: z.string().min(1),
  parentAgentId: z.string().min(1).optional(),
  definition: DefinitionReferenceSchema,
  contextId: z.string().min(1),
  lifecycle: z.enum(["open", "closed"]),
  activeInvocationId: z.string().min(1).optional(),
  nextTaskSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});

export const InvocationTreeSchema: z.ZodType<InvocationTree> = z.lazy(() =>
  z.object({
    invocation: InvocationSchema,
    children: z.array(InvocationTreeSchema),
  }),
);

export const ExecutionCursorSchema = z.object({
  executionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});

export const ExecutionEventSchema = z.object({
  schemaVersion: z.literal("pragma.execution-event/v5"),
  eventId: z.string().min(1),
  cursor: ExecutionCursorSchema,
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  type: z.string().min(1),
  data: z.unknown(),
  occurredAt: z.string().datetime(),
});

export const InvocationMessageAppendedEventSchema = ExecutionEventSchema.extend({
  type: z.literal("invocation.message.appended"),
  data: z.object({
    message: AgentMessageSchema,
  }),
});

export const ExecutionOutputItemSchema = z.object({
  sourceEventId: z.string().min(1),
  cursor: ExecutionCursorSchema.optional(),
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  parentInvocationId: z.string().min(1).optional(),
  executorId: z.string().min(1).optional(),
  contextId: z.string().min(1),
  channel: z.enum(["message", "thought", "tool", "progress", "result"]),
  delta: z.string().optional(),
  value: z.unknown().optional(),
  occurredAt: z.string().datetime(),
});

export const ExecutionRecordSchema = z.object({
  schemaVersion: z.literal("pragma.execution/v5"),
  executionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  kind: ExecutionKindSchema,
  definition: DefinitionReferenceSchema,
  rootInvocationId: z.string().min(1),
  status: ExecutionStatusSchema,
  input: z.unknown(),
  state: z.record(z.string(), z.unknown()).default({}),
  output: z.unknown().optional(),
  usage: AgentMessageUsageSchema.optional(),
  error: z.unknown().optional(),
  lastAppliedSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export interface InvocationTree {
  readonly invocation: z.infer<typeof InvocationSchema>;
  readonly children: readonly InvocationTree[];
}

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export type RuntimeSessionRef = z.infer<typeof RuntimeSessionRefSchema>;
export type ExecutionKind = z.infer<typeof ExecutionKindSchema>;
export type InvocationKind = z.infer<typeof InvocationKindSchema>;
export type DefinitionReference = z.infer<typeof DefinitionReferenceSchema>;
export type RuntimeContextSnapshot = z.infer<typeof RuntimeContextSnapshotSchema>;
export type RuntimeContextOwner = z.infer<typeof RuntimeContextOwnerSchema>;
export type RuntimeContextOrigin = z.infer<typeof RuntimeContextOriginSchema>;
export type RuntimeContextRecord = z.infer<typeof RuntimeContextRecordSchema>;
export type RuntimeEnvironmentBinding = z.infer<typeof RuntimeEnvironmentBindingSchema>;
export type ContextResolutionRecord = z.infer<typeof ContextResolutionRecordSchema>;
export type Invocation = z.infer<typeof InvocationSchema>;
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;
export type ExecutionCursor = z.infer<typeof ExecutionCursorSchema>;
export type ExecutionEvent<TData = unknown> = Omit<z.infer<typeof ExecutionEventSchema>, "data"> & {
  readonly data: TData;
};
export type InvocationMessageAppendedEvent = z.infer<typeof InvocationMessageAppendedEventSchema>;
export type ExecutionOutputItem = z.infer<typeof ExecutionOutputItemSchema>;
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

/**
 * Returns whether a status is an immutable outcome. `interrupted` is terminal for
 * observers and joins, but remains resumable by recovery and cancellation flows.
 */
export function isFinalExecutionStatus(status: ExecutionStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
