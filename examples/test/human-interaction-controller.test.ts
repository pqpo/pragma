import { describe, expect, it } from "vitest";

import { HumanInteractionQueue } from "../src/console/human-interaction-controller.ts";

describe("HumanInteractionQueue", () => {
  it("collects multiple questions and queues tool approval behind them", () => {
    const queue = new HumanInteractionQueue();
    queue.enqueue({
      interactionId: "review",
      invocationId: "review-invocation",
      request: {
        kind: "user_question",
        toolName: "askUserQuestion",
        questions: [
          {
            header: "Decision",
            question: "Decision?",
            kind: "single_choice",
            options: [
              { label: "approve", description: "Approve" },
              { label: "revise", description: "Revise" },
            ],
          },
          { header: "Notes", question: "Notes?", kind: "text", options: [] },
        ],
      },
    });
    queue.enqueue({
      interactionId: "approval",
      invocationId: "expert-invocation",
      request: {
        kind: "tool_approval",
        toolName: "publish",
        input: {},
        reason: "External side effect",
      },
    });
    expect(queue.size).toBe(2);
    queue.moveOption(1);
    expect(queue.submit()).toBeUndefined();
    const reviewResponse = queue.submit("Tighten scope.");
    expect(reviewResponse).toEqual({
      interactionId: "review",
      invocationId: "review-invocation",
      response: {
        kind: "user_question",
        answered: true,
        answers: { "Decision?": "revise", "Notes?": "Tighten scope." },
      },
    });
    expect(queue.submit()).toEqual(reviewResponse);
    expect(queue.size).toBe(2);
    expect(queue.remove("review")).toBe("review-invocation");
    expect(queue.size).toBe(1);
    expect(queue.remove("missing")).toBeUndefined();
    const approvalResponse = queue.submit();
    expect(approvalResponse).toEqual({
      interactionId: "approval",
      invocationId: "expert-invocation",
      response: { kind: "tool_approval", approved: true, reason: "User approved." },
    });
    expect(queue.size).toBe(1);
    expect(queue.remove("approval")).toBe("expert-invocation");
    expect(queue.size).toBe(0);
  });
});
