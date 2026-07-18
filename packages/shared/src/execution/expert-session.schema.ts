import { z } from "zod";

import { AgentMessageSchema } from "../agent-message.schema.ts";
import { ExecutionStatusSchema, RuntimeContextRecordSchema } from "./execution.schema.ts";

export const PromptModeSchema = z.enum(["enqueue", "steer"]);
export const PromptStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const PromptRuntimeModelSelectionSchema = z.object({
  model: z.object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
  }),
  thinkingLevel: z.string().trim().min(1).optional(),
});

export const PromptRequestSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  content: z.string().min(1),
  mode: PromptModeSchema,
  executionId: z.string().min(1),
  status: PromptStatusSchema,
  modelSelection: PromptRuntimeModelSelectionSchema.optional(),
  targetExecutionId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ExpertSessionRecordSchema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session/v4"),
    sessionId: z.string().min(1),
    expertId: z.string().min(1),
    expertVersion: z.string().min(1),
    definitionFingerprint: z.string().length(64),
    status: z.enum(["open", "closed"]),
    activeExecutionId: z.string().min(1).optional(),
    queuedRequestIds: z.array(z.string().min(1)),
    executionIds: z.array(z.string().min(1)),
    rootContextId: z.string().min(1),
    contexts: z.record(z.string(), RuntimeContextRecordSchema),
    lastStatus: ExecutionStatusSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    for (const [contextId, runtimeContext] of Object.entries(value.contexts)) {
      if (runtimeContext.contextId !== contextId) {
        context.addIssue({
          code: "custom",
          path: ["contexts", contextId],
          message: "ExpertSession Context key must match contextId.",
        });
      }
      if (
        runtimeContext.owner.type !== "expert-session" ||
        runtimeContext.owner.ownerId !== value.sessionId
      ) {
        context.addIssue({
          code: "custom",
          path: ["contexts", contextId, "owner"],
          message: "ExpertSession Context owner must match the Session.",
        });
      }
      if (contextId !== value.rootContextId && runtimeContext.origin.type !== "invocation") {
        context.addIssue({
          code: "custom",
          path: ["contexts", contextId, "origin"],
          message: "Delegated ExpertSession Context requires an Invocation origin.",
        });
      }
    }
    const root = value.contexts[value.rootContextId];
    if (root === undefined) {
      context.addIssue({
        code: "custom",
        path: ["rootContextId"],
        message: "ExpertSession root Context is missing.",
      });
      return;
    }
    if (
      root.owner.type !== "expert-session" ||
      root.owner.ownerId !== value.sessionId ||
      root.origin.type !== "expert-session" ||
      root.origin.sessionId !== value.sessionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["rootContextId"],
        message: "ExpertSession root Context identity is invalid.",
      });
    }
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
export type PromptRuntimeModelSelection = z.infer<typeof PromptRuntimeModelSelectionSchema>;
export type PromptRequest = z.infer<typeof PromptRequestSchema>;
export type ExpertSessionRecord = z.infer<typeof ExpertSessionRecordSchema>;
export type ExpertSessionEventCursor = z.infer<typeof ExpertSessionEventCursorSchema>;
export type ExpertSessionEvent = z.infer<typeof ExpertSessionEventSchema>;
export type AgentMessageRecord = z.infer<typeof AgentMessageRecordSchema>;
export type InvocationMessageHistory = z.infer<typeof InvocationMessageHistorySchema>;
export type ExpertMessageHistory = z.infer<typeof ExpertMessageHistorySchema>;
