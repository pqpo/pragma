import { z } from "zod";

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

const ExpertSessionMessageBaseSchema = z.object({
  sessionId: z.string().min(1),
  executionId: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const ExpertSessionUserMessageSchema = ExpertSessionMessageBaseSchema.extend({
  role: z.literal("user"),
  requestId: z.string().min(1),
  content: z.string(),
});

export const ExpertSessionAssistantMessageSchema = ExpertSessionMessageBaseSchema.extend({
  role: z.literal("assistant"),
  content: z.unknown(),
});

export const ExpertSessionMessageSchema = z.discriminatedUnion("role", [
  ExpertSessionUserMessageSchema,
  ExpertSessionAssistantMessageSchema,
]);

export type PromptMode = z.infer<typeof PromptModeSchema>;
export type PromptStatus = z.infer<typeof PromptStatusSchema>;
export type PromptRequest = z.infer<typeof PromptRequestSchema>;
export type ExpertSessionRecord = z.infer<typeof ExpertSessionRecordSchema>;
export type ExpertSessionUserMessage = z.infer<typeof ExpertSessionUserMessageSchema>;
export type ExpertSessionAssistantMessage = z.infer<typeof ExpertSessionAssistantMessageSchema>;
export type ExpertSessionMessage = z.infer<typeof ExpertSessionMessageSchema>;
