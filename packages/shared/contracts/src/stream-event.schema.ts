import { z } from "zod";
import { AgentMessageUsageSchema } from "./agent-message.schema.ts";

export const ExpertAgentStreamSchemaVersionSchema = z.literal("expertmesh.stream/v1");

export const ExpertAgentStreamSourceFrameSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
});

export const ExpertAgentStreamSourceSchema = z.object({
  kind: z.enum(["agent", "subagent", "runtime", "tool"]),
  runId: z.string().min(1),
  parentRunId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  toolKind: z.enum(["tool", "subagent"]).optional(),
  path: z.array(ExpertAgentStreamSourceFrameSchema).default([]),
});

const ExpertAgentStreamEventBaseSchema = z.object({
  schemaVersion: ExpertAgentStreamSchemaVersionSchema,
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  runId: z.string().min(1),
  parentRunId: z.string().min(1).optional(),
  emittedAt: z.string().datetime(),
  source: ExpertAgentStreamSourceSchema,
});

export const ExpertAgentRunStartedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("run.started"),
  payload: z.object({
    task: z.string().min(1),
    inputSummary: z.string().optional(),
  }),
});

export const ExpertAgentRunCompletedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("run.completed"),
  payload: z.object({
    outputSummary: z.string().optional(),
    usage: AgentMessageUsageSchema.optional(),
  }),
});

export const ExpertAgentRunFailedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("run.failed"),
  payload: z.object({
    message: z.string().min(1),
    code: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
  }),
});

export const ExpertAgentRunCancelledEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("run.cancelled"),
  payload: z.object({
    reason: z.string().optional(),
  }),
});

export const ExpertAgentMessageDeltaEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("message.delta"),
  payload: z.object({
    role: z.enum(["assistant", "system"]),
    contentType: z.enum(["text", "json"]),
    delta: z.string(),
  }),
});

export const ExpertAgentMessageCompletedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("message.completed"),
  payload: z.object({
    role: z.enum(["assistant", "system"]),
    contentType: z.enum(["text", "json"]),
    text: z.string().optional(),
  }),
});

export const ExpertAgentThoughtDeltaEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("thought.delta"),
  payload: z.object({
    contentType: z.literal("text"),
    delta: z.string(),
  }),
});

export const ExpertAgentProgressEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("progress"),
  payload: z.object({
    stage: z.string().min(1),
    message: z.string().min(1).optional(),
    data: z.unknown().optional(),
  }),
});

export const ExpertAgentToolStartedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("tool.started"),
  payload: z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    kind: z.enum(["tool", "subagent"]).default("tool"),
    inputPreview: z.unknown().optional(),
  }),
});

export const ExpertAgentToolDeltaEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("tool.delta"),
  payload: z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    kind: z.enum(["tool", "subagent"]).default("tool"),
    channel: z.enum(["stdout", "stderr", "message", "data"]),
    delta: z.string(),
  }),
});

export const ExpertAgentToolApprovalRequestedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("tool.approval_requested"),
  payload: z.object({
    approvalId: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    kind: z.enum(["tool", "subagent"]).default("tool"),
    reason: z.string().min(1).optional(),
    inputPreview: z.unknown().optional(),
  }),
});

export const ExpertAgentToolCompletedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("tool.completed"),
  payload: z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    kind: z.enum(["tool", "subagent"]).default("tool"),
    outputPreview: z.unknown().optional(),
  }),
});

export const ExpertAgentToolFailedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("tool.failed"),
  payload: z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    kind: z.enum(["tool", "subagent"]).default("tool"),
    message: z.string().min(1),
  }),
});

export const ExpertAgentArtifactCreatedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("artifact.created"),
  payload: z.object({
    artifactId: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const ExpertAgentStreamEventSchema = z.discriminatedUnion("type", [
  ExpertAgentRunStartedEventSchema,
  ExpertAgentRunCompletedEventSchema,
  ExpertAgentRunFailedEventSchema,
  ExpertAgentRunCancelledEventSchema,
  ExpertAgentMessageDeltaEventSchema,
  ExpertAgentMessageCompletedEventSchema,
  ExpertAgentThoughtDeltaEventSchema,
  ExpertAgentProgressEventSchema,
  ExpertAgentToolStartedEventSchema,
  ExpertAgentToolDeltaEventSchema,
  ExpertAgentToolApprovalRequestedEventSchema,
  ExpertAgentToolCompletedEventSchema,
  ExpertAgentToolFailedEventSchema,
  ExpertAgentArtifactCreatedEventSchema,
]);

export type ExpertAgentStreamSchemaVersion = z.infer<typeof ExpertAgentStreamSchemaVersionSchema>;
export type ExpertAgentStreamSourceFrame = z.infer<typeof ExpertAgentStreamSourceFrameSchema>;
export type ExpertAgentStreamSource = z.infer<typeof ExpertAgentStreamSourceSchema>;
export type ExpertAgentStreamEvent = z.infer<typeof ExpertAgentStreamEventSchema>;
