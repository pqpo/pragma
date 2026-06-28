import type { RuntimeStreamEvent, RuntimeStreamEventInput } from "@expertmesh/core";

import type { PiToolExecutionEvent } from "./session-events.ts";

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
  readonly toolEvent: PiToolExecutionEvent;
}): readonly RuntimeStreamEventInput[] {
  const toolSource = createToolSource(options.source, options.toolEvent.toolCallId);
  const toolKind = readToolKind(toolSource, options.toolEvent.toolName);

  if (options.toolEvent.type === "started") {
    return [
      {
        runId: options.runId,
        ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
        source: toolSource,
        type: "tool.started",
        payload: {
          toolCallId: options.toolEvent.toolCallId,
          toolName: options.toolEvent.toolName,
          kind: toolKind,
          inputPreview: options.toolEvent.args,
        },
      },
    ];
  }

  if (options.toolEvent.type === "updated") {
    const text = stringifyToolOutput(options.toolEvent.partialResult);

    return text === undefined
      ? []
      : [
          {
            runId: options.runId,
            ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
            source: toolSource,
            type: "tool.delta",
            payload: {
              toolCallId: options.toolEvent.toolCallId,
              toolName: options.toolEvent.toolName,
              kind: toolKind,
              channel: "message",
              delta: text,
            },
          },
        ];
  }

  const outputText = stringifyToolOutput(options.toolEvent.result);

  return [
    {
      runId: options.runId,
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      source: toolSource,
      type: options.toolEvent.isError ? "tool.failed" : "tool.completed",
      payload: options.toolEvent.isError
        ? {
            toolCallId: options.toolEvent.toolCallId,
            toolName: options.toolEvent.toolName,
            kind: toolKind,
            message: outputText ?? "Tool execution failed",
          }
        : {
            toolCallId: options.toolEvent.toolCallId,
            toolName: options.toolEvent.toolName,
            kind: toolKind,
            outputPreview: options.toolEvent.result,
          },
    },
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

function readToolKind(
  source: RuntimeStreamEvent["source"],
  toolName: string,
): "tool" | "subagent" {
  return source.toolKind === "subagent" || toolName === "launch_subagent" ? "subagent" : "tool";
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
