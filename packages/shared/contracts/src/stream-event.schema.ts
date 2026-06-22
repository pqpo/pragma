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

export const ExpertAgentRunAbortedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("run.aborted"),
  payload: z.object({
    reason: z.string().optional(),
  }),
});

export const ExpertAgentMessageDeltaEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("message.delta"),
  payload: z.object({
    role: z.enum(["assistant", "tool", "system"]),
    contentType: z.enum(["text", "json"]),
    delta: z.string(),
  }),
});

export const ExpertAgentMessageCompletedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("message.completed"),
  payload: z.object({
    role: z.enum(["assistant", "tool", "system"]),
    contentType: z.enum(["text", "json"]),
    text: z.string().optional(),
  }),
});

export const ExpertAgentToolStartedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("tool.started"),
  payload: z.object({
    toolName: z.string().min(1),
    inputPreview: z.unknown().optional(),
  }),
});

export const ExpertAgentToolCompletedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("tool.completed"),
  payload: z.object({
    toolName: z.string().min(1),
    outputPreview: z.unknown().optional(),
  }),
});

export const ExpertAgentToolFailedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("tool.failed"),
  payload: z.object({
    toolName: z.string().min(1),
    message: z.string().min(1),
  }),
});

export const ExpertAgentSubAgentStartedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("subagent.started"),
  payload: z.object({
    agentType: z.string().min(1),
    task: z.string().min(1),
    childRunId: z.string().min(1),
  }),
});

export const ExpertAgentSubAgentCompletedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("subagent.completed"),
  payload: z.object({
    agentType: z.string().min(1),
    childRunId: z.string().min(1),
    outputSummary: z.string().optional(),
  }),
});

export const ExpertAgentSubAgentFailedEventSchema = ExpertAgentStreamEventBaseSchema.extend({
  type: z.literal("subagent.failed"),
  payload: z.object({
    agentType: z.string().min(1),
    childRunId: z.string().min(1),
    message: z.string().min(1),
  }),
});

export const ExpertAgentStreamEventSchema = z.discriminatedUnion("type", [
  ExpertAgentRunStartedEventSchema,
  ExpertAgentRunCompletedEventSchema,
  ExpertAgentRunFailedEventSchema,
  ExpertAgentRunAbortedEventSchema,
  ExpertAgentMessageDeltaEventSchema,
  ExpertAgentMessageCompletedEventSchema,
  ExpertAgentToolStartedEventSchema,
  ExpertAgentToolCompletedEventSchema,
  ExpertAgentToolFailedEventSchema,
  ExpertAgentSubAgentStartedEventSchema,
  ExpertAgentSubAgentCompletedEventSchema,
  ExpertAgentSubAgentFailedEventSchema,
]);

export type ExpertAgentStreamSchemaVersion = z.infer<typeof ExpertAgentStreamSchemaVersionSchema>;
export type ExpertAgentStreamSourceFrame = z.infer<typeof ExpertAgentStreamSourceFrameSchema>;
export type ExpertAgentStreamSource = z.infer<typeof ExpertAgentStreamSourceSchema>;
export type ExpertAgentStreamEvent = z.infer<typeof ExpertAgentStreamEventSchema>;
