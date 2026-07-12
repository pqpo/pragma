import { z } from "zod";
import { AgentMessageUsageSchema } from "../agent-message.schema.ts";

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

export const ExecutionKindSchema = z.enum(["expert-turn", "flow"]);

export const InvocationKindSchema = z.enum(["flow", "task", "human-task", "expert", "expert-team"]);

export const DefinitionReferenceSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: InvocationKindSchema,
});

export const RuntimeContextSnapshotSchema = z.object({
  expertId: z.string().min(1),
  runtimeId: z.string().min(1),
  systemSessionId: z.string().min(1),
  runtimeSession: RuntimeSessionRefSchema,
});

export const InvocationRuntimeContextSchema = RuntimeContextSnapshotSchema.extend({
  contextId: z.string().min(1),
});

export const InvocationSchema = z.object({
  invocationId: z.string().min(1),
  rootInvocationId: z.string().min(1),
  parentInvocationId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  definition: DefinitionReferenceSchema,
  executorId: z.string().min(1).optional(),
  status: ExecutionStatusSchema,
  input: z.unknown(),
  output: z.unknown().optional(),
  usage: AgentMessageUsageSchema.optional(),
  error: z.unknown().optional(),
  runtimeContext: InvocationRuntimeContextSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
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
  eventId: z.string().min(1),
  cursor: ExecutionCursorSchema,
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string().datetime(),
});

export const ExecutionOutputEventSchema = z.object({
  eventId: z.string().min(1),
  cursor: ExecutionCursorSchema,
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  channel: z.enum(["message", "thought", "tool", "progress", "result"]),
  delta: z.string().optional(),
  value: z.unknown().optional(),
  occurredAt: z.string().datetime(),
});

export const ExecutionRecordSchema = z.object({
  schemaVersion: z.literal("pragma.execution/v1"),
  executionId: z.string().min(1),
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
export type InvocationRuntimeContext = z.infer<typeof InvocationRuntimeContextSchema>;
export type Invocation = z.infer<typeof InvocationSchema>;
export type ExecutionCursor = z.infer<typeof ExecutionCursorSchema>;
export type ExecutionEvent<TPayload = unknown> = Omit<
  z.infer<typeof ExecutionEventSchema>,
  "payload"
> & { readonly payload: TPayload };
export type ExecutionOutputEvent = z.infer<typeof ExecutionOutputEventSchema>;
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
