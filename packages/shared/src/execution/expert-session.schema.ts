import { z } from "zod";

import { AgentMessageSchema } from "../agent-message.schema.ts";
import { ExecutionStatusSchema, RuntimeContextSnapshotSchema } from "./execution.schema.ts";

export const PromptModeSchema = z.enum(["enqueue", "steer"]);
export const PromptStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const PromptRequestSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  content: z.string().min(1),
  mode: PromptModeSchema,
  executionId: z.string().min(1),
  status: PromptStatusSchema,
  targetExecutionId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ExpertSessionRecordSchema = z.object({
  schemaVersion: z.literal("pragma.expert-session/v1"),
  sessionId: z.string().min(1),
  expertId: z.string().min(1),
  expertVersion: z.string().min(1),
  status: z.enum(["open", "closed"]),
  activeExecutionId: z.string().min(1).optional(),
  queuedRequestIds: z.array(z.string().min(1)),
  executionIds: z.array(z.string().min(1)),
  runtimeId: z.string().min(1).optional(),
  contextIds: z.record(z.string(), z.string().min(1)),
  runtimeContexts: z.record(z.string(), RuntimeContextSnapshotSchema),
  lastStatus: ExecutionStatusSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ExpertSessionEventCursorSchema = z.object({
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});

export const ExpertSessionEventSchema = z.object({
  schemaVersion: z.literal("pragma.expert-session-event/v1"),
  eventId: z.string().min(1),
  cursor: ExpertSessionEventCursorSchema,
  sessionId: z.string().min(1),
  type: z.string().min(1),
  data: z.unknown(),
  occurredAt: z.string().datetime(),
});

export const AgentMessageRecordSchema = z.object({
  sequence: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  parentInvocationId: z.string().min(1).optional(),
  executorId: z.string().min(1).optional(),
  contextId: z.string().min(1),
  message: AgentMessageSchema,
});

export const InvocationMessageHistorySchema = z.object({
  sessionId: z.string().min(1),
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  parentInvocationId: z.string().min(1).optional(),
  executorId: z.string().min(1).optional(),
  contextId: z.string().min(1),
  messages: z.array(AgentMessageRecordSchema),
});

export const ExpertMessageHistorySchema = z.object({
  executorId: z.string().min(1).optional(),
  contextId: z.string().min(1),
  invocations: z.array(InvocationMessageHistorySchema),
});

export type PromptMode = z.infer<typeof PromptModeSchema>;
export type PromptStatus = z.infer<typeof PromptStatusSchema>;
export type PromptRequest = z.infer<typeof PromptRequestSchema>;
export type ExpertSessionRecord = z.infer<typeof ExpertSessionRecordSchema>;
export type ExpertSessionEventCursor = z.infer<typeof ExpertSessionEventCursorSchema>;
export type ExpertSessionEvent = z.infer<typeof ExpertSessionEventSchema>;
export type AgentMessageRecord = z.infer<typeof AgentMessageRecordSchema>;
export type InvocationMessageHistory = z.infer<typeof InvocationMessageHistorySchema>;
export type ExpertMessageHistory = z.infer<typeof ExpertMessageHistorySchema>;
