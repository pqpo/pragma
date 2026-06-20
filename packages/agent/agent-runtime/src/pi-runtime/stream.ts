import type { RuntimeStreamEvent } from "@expertmesh/agent-core";
import { randomUUID } from "node:crypto";

import type { PiToolExecutionEvent } from "./session-events.ts";
import type { RuntimeStreamBridge } from "./types.ts";

export function createRuntimeStreamBridge(): RuntimeStreamBridge {
  return {
    nextSequence: createSequenceCounter(),
  };
}

export function createSequenceCounter(): () => number {
  let sequence = 0;

  return () => sequence++;
}

export function createChildRunId(parentRunId: string | undefined): string {
  return parentRunId === undefined
    ? `subagent-${randomUUID()}`
    : `${parentRunId}:subagent:${randomUUID()}`;
}

export function createStreamEvent(
  event: Omit<RuntimeStreamEvent, "schemaVersion" | "eventId" | "emittedAt">,
): RuntimeStreamEvent {
  return {
    schemaVersion: "expertmesh.stream/v1",
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    ...event,
  } as RuntimeStreamEvent;
}

export function summarizeInput(input: unknown): string {
  return summarizeText(
    typeof input === "string" ? input : (JSON.stringify(input) ?? String(input)),
  );
}

export function summarizeText(text: string): string {
  return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
}

export function createToolStreamEvents(options: {
  readonly runId: string;
  readonly parentRunId?: string | undefined;
  readonly source: RuntimeStreamEvent["source"];
  readonly sequence: () => number;
  readonly toolEvent: PiToolExecutionEvent;
}): readonly RuntimeStreamEvent[] {
  const toolSource = createToolSource(options.source, options.toolEvent.toolCallId);

  if (options.toolEvent.type === "started") {
    return [
      createStreamEvent({
        runId: options.runId,
        ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
        source: toolSource,
        sequence: options.sequence(),
        type: "tool.started",
        payload: {
          toolName: options.toolEvent.toolName,
          inputPreview: options.toolEvent.args,
        },
      }),
    ];
  }

  if (options.toolEvent.type === "updated") {
    const text = stringifyToolOutput(options.toolEvent.partialResult);

    return text === undefined
      ? []
      : [
          createStreamEvent({
            runId: options.runId,
            ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
            source: toolSource,
            sequence: options.sequence(),
            type: "message.delta",
            payload: {
              role: "tool",
              contentType: "text",
              delta: text,
            },
          }),
        ];
  }

  const outputText = stringifyToolOutput(options.toolEvent.result);

  return [
    createStreamEvent({
      runId: options.runId,
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      source: toolSource,
      sequence: options.sequence(),
      type: options.toolEvent.isError ? "tool.failed" : "tool.completed",
      payload: options.toolEvent.isError
        ? {
            toolName: options.toolEvent.toolName,
            message: outputText ?? "Tool execution failed",
          }
        : {
            toolName: options.toolEvent.toolName,
            outputPreview: options.toolEvent.result,
          },
    }),
    ...(outputText === undefined
      ? []
      : [
          createStreamEvent({
            runId: options.runId,
            ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
            source: toolSource,
            sequence: options.sequence(),
            type: "message.completed",
            payload: {
              role: "tool",
              contentType: "text",
              text: outputText,
            },
          }),
        ]),
  ];
}

function createToolSource(
  source: RuntimeStreamEvent["source"],
  toolCallId: string,
): RuntimeStreamEvent["source"] {
  return {
    ...source,
    kind: "tool",
    toolCallId,
  };
}

function stringifyToolOutput(output: unknown): string | undefined {
  if (typeof output === "string") {
    return output;
  }

  if (isRecord(output)) {
    const content = output["content"];

    if (Array.isArray(content)) {
      const text = content
        .map((item) =>
          isRecord(item) && typeof item["text"] === "string" ? item["text"] : undefined,
        )
        .filter((item): item is string => item !== undefined)
        .join("\n");

      if (text.length > 0) {
        return text;
      }
    }

    const text = output["text"];

    if (typeof text === "string") {
      return text;
    }
  }

  return output === undefined ? undefined : summarizeText(JSON.stringify(output) ?? String(output));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
