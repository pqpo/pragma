import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export function readAssistantTextDelta(event: AgentSessionEvent): string | undefined {
  if (event.type !== "message_update") {
    return undefined;
  }

  if (event.assistantMessageEvent.type === "text_delta") {
    return event.assistantMessageEvent.delta;
  }

  return undefined;
}

export type PiToolExecutionEvent =
  | {
      readonly type: "started";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: "updated";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
      readonly partialResult: unknown;
    }
  | {
      readonly type: "completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError: boolean;
    };

export function readToolExecutionEvent(event: AgentSessionEvent): PiToolExecutionEvent | undefined {
  if (event.type === "tool_execution_start") {
    return {
      type: "started",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    };
  }

  if (event.type === "tool_execution_update") {
    return {
      type: "updated",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      partialResult: event.partialResult,
    };
  }

  if (event.type === "tool_execution_end") {
    return {
      type: "completed",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    };
  }

  return undefined;
}
