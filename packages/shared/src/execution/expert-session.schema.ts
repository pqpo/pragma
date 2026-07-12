import { z } from "zod";

import { ExecutionStatusSchema } from "./execution.schema.ts";

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
  systemSessionId: z.string().min(1).optional(),
  runtimeSession: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
  contextIds: z.record(z.string(), z.string().min(1)),
  runtimeContexts: z.record(
    z.string(),
    z.object({
      expertId: z.string().min(1),
      runtimeId: z.string().min(1),
      systemSessionId: z.string().min(1),
      runtimeSession: z.object({ type: z.string().min(1), id: z.string().min(1) }),
    }),
  ),
  lastStatus: ExecutionStatusSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PromptMode = z.infer<typeof PromptModeSchema>;
export type PromptStatus = z.infer<typeof PromptStatusSchema>;
export type PromptRequest = z.infer<typeof PromptRequestSchema>;
export type ExpertSessionRecord = z.infer<typeof ExpertSessionRecordSchema>;
