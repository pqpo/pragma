import {
  ExecutionOutputItemSchema,
  type ExecutionOutputItem,
  type ExpertAgentStreamEvent,
  type Invocation,
} from "@pragma/shared";

export function projectRuntimeOutput(options: {
  readonly executionId: string;
  readonly invocation: Invocation;
  readonly event: ExpertAgentStreamEvent;
}): ExecutionOutputItem | undefined {
  const { event, executionId, invocation } = options;
  const base = {
    sourceEventId: event.eventId,
    executionId,
    invocationId: invocation.invocationId,
    parentInvocationId: invocation.parentInvocationId,
    executorId: invocation.executorId,
    contextId: invocation.contextId,
    runId: event.runId,
    ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId }),
    source: event.source,
    occurredAt: event.emittedAt,
  };
  switch (event.type) {
    case "message.delta":
      return ExecutionOutputItemSchema.parse({
        ...base,
        channel: "message",
        delta: event.payload.delta,
      });
    case "message.completed":
      return ExecutionOutputItemSchema.parse({
        ...base,
        channel: "message",
        value: event.payload.message ?? event.payload.text,
      });
    case "thought.delta":
      return ExecutionOutputItemSchema.parse({
        ...base,
        channel: "thought",
        delta: event.payload.delta,
      });
    case "tool.delta":
      return ExecutionOutputItemSchema.parse({
        ...base,
        channel: "tool",
        delta: event.payload.delta,
      });
    case "tool.started":
    case "tool.completed":
    case "tool.failed":
    case "tool.approval_requested":
      return ExecutionOutputItemSchema.parse({ ...base, channel: "tool", value: event.payload });
    case "progress":
      return ExecutionOutputItemSchema.parse({
        ...base,
        channel: "progress",
        value: event.payload,
      });
    case "agent.command":
      return ExecutionOutputItemSchema.parse({
        ...base,
        channel: "agent",
        value: event.payload,
      });
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      if (event.source.parentSessionId === undefined) return undefined;
      return ExecutionOutputItemSchema.parse({
        ...base,
        channel: "agent",
        value: { type: event.type, ...event.payload },
      });
    default:
      return undefined;
  }
}
