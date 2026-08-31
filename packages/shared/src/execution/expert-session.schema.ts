import { z } from "zod";

import { AgentMessageSchema } from "../agent-message.schema.ts";
import { ExpertAgentStreamSourceSchema } from "../stream-event.schema.ts";
import {
  ExecutionStatusSchema,
  RuntimeContextRecordSchema,
  RuntimeModelSelectionSchema,
} from "./execution.schema.ts";

export const PromptModeSchema = z.enum(["enqueue", "steer"]);
export const PromptStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const PromptPurposeSchema = z.enum(["user", "human_checkpoint_recovery"]);

export const PromptDeliveryAttemptSchema = z
  .object({
    attemptId: z.string().min(1),
    kind: z.enum(["strict_steer", "queue_steer"]),
    sourceExecutionId: z.string().min(1).optional(),
    targetExecutionId: z.string().min(1),
    state: z.enum(["dispatching", "confirmed", "not_dispatched", "uncertain"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "queue_steer" && value.sourceExecutionId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceExecutionId"],
        message: "Queue steer delivery attempts require the source Execution.",
      });
    }
  });

export const PromptRequestSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  content: z.string().min(1),
  purpose: PromptPurposeSchema.default("user"),
  mode: PromptModeSchema,
  executionId: z.string().min(1),
  status: PromptStatusSchema,
  modelSelection: RuntimeModelSelectionSchema.optional(),
  targetExecutionId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  deliveryAttempt: PromptDeliveryAttemptSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ExpertSessionRecordSchema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session/v6"),
    sessionId: z.string().min(1),
    expertId: z.string().min(1),
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
  runId: z.string().min(1).optional(),
  parentRunId: z.string().min(1).optional(),
  source: ExpertAgentStreamSourceSchema.optional(),
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
export type PromptPurpose = z.infer<typeof PromptPurposeSchema>;
export type PromptDeliveryAttempt = z.infer<typeof PromptDeliveryAttemptSchema>;
export type PromptRuntimeModelSelection = z.infer<typeof RuntimeModelSelectionSchema>;
export type PromptRequest = z.infer<typeof PromptRequestSchema>;
export type ExpertSessionRecord = z.infer<typeof ExpertSessionRecordSchema>;
export type ExpertSessionEventCursor = z.infer<typeof ExpertSessionEventCursorSchema>;
export type ExpertSessionEvent = z.infer<typeof ExpertSessionEventSchema>;
export type AgentMessageRecord = z.infer<typeof AgentMessageRecordSchema>;
export type InvocationMessageHistory = z.infer<typeof InvocationMessageHistorySchema>;
export type ExpertMessageHistory = z.infer<typeof ExpertMessageHistorySchema>;
