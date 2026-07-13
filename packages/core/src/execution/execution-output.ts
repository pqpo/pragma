import {
  ExecutionOutputItemSchema,
  ExecutionRuntimeStreamEventSchema,
  type ExecutionEvent,
  type ExecutionOutputItem,
} from "@pragma/shared";

export function projectExecutionOutput(event: ExecutionEvent): ExecutionOutputItem | undefined {
  if (event.type === "invocation.succeeded") {
    return createOutput(event, "result", undefined, readDataField(event.data, "output"));
  }

  if (event.type === "invocation.progress") {
    return createOutput(event, "progress", undefined, readDataField(event.data, "value"));
  }

  if (event.type !== "runtime.stream") return undefined;
  const runtimeEvent = ExecutionRuntimeStreamEventSchema.parse(event).data;

  switch (runtimeEvent.type) {
    case "message.delta":
      return createOutput(event, "message", runtimeEvent.payload.delta);
    case "message.completed":
      return createOutput(event, "message", undefined, runtimeEvent.payload.text);
    case "thought.delta":
      return createOutput(event, "thought", runtimeEvent.payload.delta);
    case "tool.delta":
      return createOutput(event, "tool", runtimeEvent.payload.delta);
    case "progress":
      return createOutput(event, "progress", undefined, runtimeEvent.payload);
    default:
      return undefined;
  }
}

function createOutput(
  event: ExecutionEvent,
  channel: ExecutionOutputItem["channel"],
  delta?: string,
  value?: unknown,
): ExecutionOutputItem {
  return ExecutionOutputItemSchema.parse({
    sourceEventId: event.eventId,
    cursor: event.cursor,
    executionId: event.executionId,
    invocationId: event.invocationId,
    channel,
    ...(delta === undefined ? {} : { delta }),
    ...(value === undefined ? {} : { value }),
    occurredAt: event.occurredAt,
  });
}

function readDataField(data: unknown, field: string): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[field];
}
