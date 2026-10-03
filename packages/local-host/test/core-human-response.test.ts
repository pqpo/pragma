import { describe, expect, it } from "vitest";
import { HumanInteractionRequestEnvelopeSchema } from "@pragma/shared/integration";
import { HumanInteractionRequestSchema } from "@pragma/shared";
import { mapExecutionEvent, toCoreResponse } from "../src/core-run.ts";

function mappedRequest(request: unknown) {
  const event = mapExecutionEvent(
    {
      eventId: "request-event",
      occurredAt: "2026-10-02T00:00:00.000Z",
      type: "human.requested",
      cursor: { sequence: 1 },
      data: { interactionId: "00000000-0000-4000-8000-000000000003", request },
    } as Parameters<typeof mapExecutionEvent>[0],
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    new Map(),
  );
  return HumanInteractionRequestEnvelopeSchema.parse(event.data).interaction;
}

describe("Core human response normalization shared by Desktop and CLI", () => {
  it("preserves user-question approval semantics and keyed decisions", () => {
    const request = mappedRequest({
      kind: "user_question",
      semantics: { kind: "approval", approveOption: "Accept" },
      questions: [
        {
          header: "Review",
          question: "Apply this change?",
          kind: "single_choice",
          options: [
            { label: "Accept", description: "yes" },
            { label: "Decline", description: "no" },
          ],
        },
      ],
    });
    expect(request).toMatchObject({ kind: "approval", approveOption: "Accept" });
    expect(toCoreResponse(request, { approved: true })).toMatchObject({
      kind: "user_question",
      answers: { "Apply this change?": "Accept" },
    });
    expect(toCoreResponse(request, { approved: false })).toMatchObject({
      kind: "user_question",
      answers: { "Apply this change?": "Decline" },
    });
  });

  it("maps Desktop text notes and preserves explicit multi-question answers", () => {
    const request = mappedRequest({
      kind: "user_question",
      questions: [
        { header: "Name", question: "What name?", kind: "text", options: [] },
        {
          header: "Scope",
          question: "Which scope?",
          kind: "single_choice",
          options: [{ label: "All", description: "all" }],
        },
      ],
    });
    expect(
      toCoreResponse(request, { notes: "Pragma", answers: { "Which scope?": "All" } }),
    ).toEqual({
      kind: "user_question",
      answered: true,
      answers: { "What name?": "Pragma", "Which scope?": "All" },
      notes: "Pragma",
    });
  });

  it.each(["approved", "approve"])("accepts the existing tool approval decision %s", (decision) => {
    const request = mappedRequest({
      kind: "tool_approval",
      toolName: "shell",
      toolCallId: "shell-call",
      input: {},
    });
    expect(toCoreResponse(request, { decision })).toMatchObject({
      kind: "tool_approval",
      approved: true,
    });
    expect(toCoreResponse(request, {})).toMatchObject({ kind: "tool_approval", approved: false });
  });

  it("retains existing generic Flow question response fields", () => {
    const request = HumanInteractionRequestSchema.parse({
      kind: "question",
      prompt: "Review this run.",
    });
    expect(toCoreResponse(request, { answers: { "Review this run.": "approved" } })).toEqual({
      kind: "user_question",
      answered: true,
      answers: { "Review this run.": "approved" },
    });
  });
});
