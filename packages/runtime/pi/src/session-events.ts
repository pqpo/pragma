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

export function readAssistantThinkingDelta(event: AgentSessionEvent): string | undefined {
  if (event.type !== "message_update") {
    return undefined;
  }

  if (event.assistantMessageEvent.type === "thinking_delta") {
    return event.assistantMessageEvent.delta;
  }

  return undefined;
}

export function readAssistantMessageText(event: AgentSessionEvent): string | undefined {
  if (
    event.type !== "message_end" ||
    !isRecord(event.message) ||
    event.message["role"] !== "assistant"
  ) {
    return undefined;
  }

  return readMessageText(event.message);
}

export function assertAssistantTurnCompleted(messages: readonly unknown[]): void {
  const assistant = messages.findLast(
    (message) => isRecord(message) && message["role"] === "assistant",
  );
  if (!isRecord(assistant)) {
    throw new Error("PI Runtime completed without an assistant response.");
  }

  const stopReason = assistant["stopReason"];
  if (stopReason === "error" || stopReason === "aborted") {
    const errorMessage = assistant["errorMessage"];
    throw new Error(
      typeof errorMessage === "string" && errorMessage.trim() !== ""
        ? errorMessage
        : `PI Runtime assistant stopped with reason: ${stopReason}.`,
    );
  }

  if (readMessageText(assistant) === undefined) {
    throw new Error("PI Runtime completed with an empty assistant response.");
  }
}

export function readProgressEvent(
  event: AgentSessionEvent,
):
  | { readonly stage: string; readonly message?: string | undefined; readonly data?: unknown }
  | undefined {
  if (event.type === "turn_start") {
    return { stage: "turn.start", message: "Turn started" };
  }

  if (event.type === "turn_end") {
    return { stage: "turn.end", message: "Turn completed" };
  }

  if (event.type === "queue_update") {
    return {
      stage: "queue.update",
      message: "Prompt queue updated",
      data: {
        steering: event.steering,
        followUp: event.followUp,
      },
    };
  }

  if (event.type === "compaction_start") {
    return {
      stage: "compaction.start",
      message: "Compaction started",
      data: { reason: event.reason },
    };
  }

  if (event.type === "compaction_end") {
    return {
      stage: "compaction.end",
      message: "Compaction completed",
      data: {
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        errorMessage: event.errorMessage,
      },
    };
  }

  if (event.type === "auto_retry_start") {
    return {
      stage: "auto_retry.start",
      message: event.errorMessage,
      data: {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      },
    };
  }

  if (event.type === "auto_retry_end") {
    return {
      stage: "auto_retry.end",
      message: event.success ? "Auto retry succeeded" : "Auto retry failed",
      data: {
        success: event.success,
        attempt: event.attempt,
        finalError: event.finalError,
      },
    };
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

function readMessageText(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const content = message["content"];

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) =>
        isRecord(item) && typeof item["text"] === "string" ? item["text"] : undefined,
      )
      .filter((item): item is string => item !== undefined)
      .join("");

    return text.length === 0 ? undefined : text;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
