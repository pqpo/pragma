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
    default:
      return undefined;
  }
}
