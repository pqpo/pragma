import { describe, expect, it } from "vitest";

import type { ExpertAgentHumanRequest } from "@pragma/core";

import { toExpertHumanResponse, toStewardHumanRequest } from "../src/human-interaction.ts";

describe("Steward human interactions", () => {
  it("exposes askUserQuestion requests through the shared desktop protocol", () => {
    const request = questionRequest();

    expect(toStewardHumanRequest(request)).toEqual({
      kind: "question",
      title: "Expert",
      prompt: "Which Expert should I create?",
      questions: request.questions,
    });
  });

  it("returns structured single-choice, multiple-choice, and text answers to the Expert turn", () => {
    const request = questionRequest();

    expect(
      toExpertHumanResponse(request, {
        answers: {
          "Which Expert should I create?": "Researcher",
          "Which capabilities are required?": ["Web", "Files"],
          "What should its system prompt emphasize?": "Cite primary sources.",
        },
      }),
    ).toEqual({
      kind: "user_question",
      answered: true,
      answers: {
        "Which Expert should I create?": "Researcher",
        "Which capabilities are required?": ["Web", "Files"],
        "What should its system prompt emphasize?": "Cite primary sources.",
      },
    });
  });

  it("keeps approval-shaped questions compatible with approval controls", () => {
    const request: ExpertAgentHumanRequest = {
      kind: "user_question",
      toolName: "askUserQuestion",
      questions: [
        {
          header: "Confirm",
          question: "Apply this change?",
          kind: "single_choice",
          options: [
            { label: "Approve", description: "Apply it" },
            { label: "Reject", description: "Do not apply it" },
          ],
        },
      ],
    };

    expect(toStewardHumanRequest(request).kind).toBe("approval");
    expect(toExpertHumanResponse(request, { approved: true, decision: "approved" })).toEqual({
      kind: "user_question",
      answered: true,
      answers: { "Apply this change?": "Approve" },
    });
  });
});

function questionRequest(): ExpertAgentHumanRequest & { readonly kind: "user_question" } {
  return {
    kind: "user_question",
    toolName: "askUserQuestion",
    questions: [
      {
        header: "Expert",
        question: "Which Expert should I create?",
        kind: "single_choice",
        options: [
          { label: "Researcher", description: "Research and synthesize" },
          { label: "Reviewer", description: "Review existing work" },
        ],
      },
      {
        header: "Capabilities",
        question: "Which capabilities are required?",
        kind: "multiple_choice",
        options: [
          { label: "Web", description: "Browse the web" },
          { label: "Files", description: "Read workspace files" },
        ],
      },
      {
        header: "Prompt",
        question: "What should its system prompt emphasize?",
        kind: "text",
        options: [],
      },
    ],
  };
}
