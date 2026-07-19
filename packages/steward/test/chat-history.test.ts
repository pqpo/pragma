import { ExpertMessageHistorySchema } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  mergeStewardChatEntries,
  toStewardChatEntries,
  toStewardHumanResponseEntries,
} from "../src/chat-history.ts";

describe("Steward chat history", () => {
  it("keeps messages grouped in session turn order when Execution sequences restart", () => {
    const history = ExpertMessageHistorySchema.parse({
      contextId: "root-context",
      invocations: [
        invocation("turn-1", "invocation-1", [
          message("turn-1", "invocation-1", 2, 1, "user", "first question"),
          message("turn-1", "invocation-1", 4, 2, "assistant", [
            { type: "text", text: "first answer" },
          ]),
        ]),
        invocation("turn-2", "invocation-2", [
          message(
            "turn-2",
            "invocation-2",
            2,
            3,
            "user",
            "[Pragma Home context]\nSelected task workspace: /repo\n[/Pragma Home context]\n\nsecond question",
          ),
          message("turn-2", "invocation-2", 4, 4, "assistant", [
            { type: "text", text: "second answer" },
          ]),
        ]),
      ],
    });

    expect(toStewardChatEntries([history])).toMatchObject([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ]);
  });

  it("replaces a running tool call with its settled compact entry", () => {
    const history = ExpertMessageHistorySchema.parse({
      contextId: "root-context",
      invocations: [
        invocation("turn-1", "invocation-1", [
          message("turn-1", "invocation-1", 2, 1, "user", "list resources"),
          assistantMessage("turn-1", "invocation-1", 4, 2, [
            { type: "toolCall", id: "call-1", name: "list_resources", arguments: {} },
          ]),
          {
            sequence: 5,
            sessionId: "session",
            executionId: "turn-1",
            invocationId: "invocation-1",
            contextId: "root-context",
            message: {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "list_resources",
              content: [{ type: "text", text: '{"items":["one","two"]}' }],
              isError: false,
              timestamp: 3,
            },
          },
        ]),
      ],
    });

    expect(toStewardChatEntries([history]).filter((entry) => entry.role === "tool")).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        toolName: "list_resources",
        toolStatus: "succeeded",
        content: '{"items":["one","two"]}',
      }),
    ]);
  });

  it("preserves content block order when entries share a timestamp", () => {
    const history = ExpertMessageHistorySchema.parse({
      contextId: "root-context",
      invocations: [
        invocation("turn-1", "invocation-1", [
          message(
            "turn-1",
            "invocation-1",
            4,
            2,
            "assistant",
            Array.from({ length: 12 }, (_, index) => ({ type: "text", text: String(index) })),
          ),
        ]),
      ],
    });

    expect(
      mergeStewardChatEntries(toStewardChatEntries([history])).map((entry) => entry.content),
    ).toEqual(Array.from({ length: 12 }, (_, index) => String(index)));
  });

  it("shows an approval response as a user chat entry", () => {
    expect(
      toStewardHumanResponseEntries([
        {
          eventId: "request",
          type: "human.requested",
          occurredAt: "2026-07-19T01:00:00.000Z",
          data: {
            interactionId: "approval-1",
            request: {
              kind: "tool_approval",
              toolName: "commit_dsl_changes",
              input: { changeSetId: "change-1" },
            },
          },
        },
        {
          eventId: "response",
          type: "human.responded",
          occurredAt: "2026-07-19T01:00:01.000Z",
          data: {
            interactionId: "approval-1",
            response: { kind: "tool_approval", approved: true },
          },
        },
      ]),
    ).toEqual([
      {
        id: "human-response:approval-1",
        role: "user",
        content: "Approved commit_dsl_changes.",
        createdAt: "2026-07-19T01:00:01.000Z",
      },
    ]);
  });
});

function invocation(executionId: string, invocationId: string, messages: readonly unknown[]) {
  return {
    sessionId: "session",
    executionId,
    invocationId,
    contextId: "root-context",
    messages,
  };
}

function message(
  executionId: string,
  invocationId: string,
  sequence: number,
  timestamp: number,
  role: "user" | "assistant",
  content: unknown,
) {
  return {
    sequence,
    sessionId: "session",
    executionId,
    invocationId,
    contextId: "root-context",
    message:
      role === "user"
        ? { role, content, timestamp }
        : assistantMessage(executionId, invocationId, sequence, timestamp, content).message,
  };
}

function assistantMessage(
  executionId: string,
  invocationId: string,
  sequence: number,
  timestamp: number,
  content: unknown,
) {
  return {
    sequence,
    sessionId: "session",
    executionId,
    invocationId,
    contextId: "root-context",
    message: {
      role: "assistant" as const,
      content,
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp,
    },
  };
}
