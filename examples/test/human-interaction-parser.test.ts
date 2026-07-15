import type { ExecutionEvent } from "@pragma/core";
import { describe, expect, it } from "vitest";

import {
  createHumanInteractionResponse,
  findPendingHumanRequestEvents,
  parseConsoleApprovalAnswer,
  parseConsoleQuestionAnswer,
  parseHumanInteractionEvent,
} from "../src/console/human-interaction-parser.ts";

const options = [
  { label: "Fast", description: "Prefer speed" },
  { label: "Safe", description: "Prefer safety" },
  { label: "Balanced", description: "Balance both" },
] as const;

describe("human interaction parser", () => {
  it("parses and validates durable Human request events", () => {
    const event = executionEvent("requested", "human.requested", {
      interactionId: "interaction",
      request: {
        kind: "user_question",
        toolName: "askUserQuestion",
        questions: [{ question: "Why?", header: "Reason", kind: "text", options: [] }],
      },
    });

    expect(parseHumanInteractionEvent(event)).toMatchObject({
      interactionId: "interaction",
      invocationId: "invocation",
      request: { kind: "user_question" },
    });
  });

  it("accepts numbered, named, multiple-choice, and text answers", () => {
    expect(
      parseConsoleQuestionAnswer(
        { question: "Which mode?", header: "Mode", kind: "single_choice", options },
        "2",
      ),
    ).toEqual({ ok: true, answer: "Safe" });
    expect(
      parseConsoleQuestionAnswer(
        { question: "Which mode?", header: "Mode", kind: "single_choice", options },
        "balanced",
      ),
    ).toEqual({ ok: true, answer: "Balanced" });
    expect(
      parseConsoleQuestionAnswer(
        { question: "Which modes?", header: "Modes", kind: "multiple_choice", options },
        "1，Safe",
      ),
    ).toEqual({ ok: true, answer: "Fast, Safe" });
    expect(
      parseConsoleQuestionAnswer(
        { question: "Why?", header: "Reason", kind: "text", options: [] },
        "  Need evidence.  ",
      ),
    ).toEqual({ ok: true, answer: "Need evidence." });
  });

  it("parses approvals and builds typed responses", () => {
    expect(parseConsoleApprovalAnswer("yes")).toEqual({ ok: true, approved: true });
    expect(parseConsoleApprovalAnswer("2")).toEqual({ ok: true, approved: false });
    expect(parseConsoleApprovalAnswer("later")).toMatchObject({ ok: false });
    expect(
      createHumanInteractionResponse(
        { kind: "tool_approval", toolName: "publish", input: {}, reason: "Side effect" },
        { "publish: Side effect": "Yes" },
      ),
    ).toEqual({ kind: "tool_approval", approved: true, reason: "User approved." });
  });

  it("finds requests without a durable response", () => {
    const completed = executionEvent("completed", "human.requested", {
      interactionId: "completed",
    });
    const pending = executionEvent("pending", "human.requested", { interactionId: "pending" });
    const response = executionEvent("response", "human.responded", {
      interactionId: "completed",
    });

    expect(findPendingHumanRequestEvents([completed, pending, response])).toEqual([pending]);
  });
});

function executionEvent(
  eventId: string,
  type: ExecutionEvent["type"],
  data: unknown,
): ExecutionEvent {
  return {
    schemaVersion: "pragma.execution-event/v5",
    eventId,
    cursor: { executionId: "execution", sequence: 1 },
    executionId: "execution",
    invocationId: "invocation",
    type,
    data,
    occurredAt: new Date().toISOString(),
  };
}
