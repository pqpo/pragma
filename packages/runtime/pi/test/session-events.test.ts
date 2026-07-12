import { describe, expect, it } from "vitest";

import { assertAssistantTurnCompleted } from "../src/session-events.ts";

describe("PI assistant turn validation", () => {
  it("surfaces provider errors instead of succeeding with an empty response", () => {
    expect(() =>
      assertAssistantTurnCompleted([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "OpenAI API error (404): no body",
        },
      ]),
    ).toThrow("OpenAI API error (404): no body");
  });

  it("rejects a completed turn without assistant text", () => {
    expect(() =>
      assertAssistantTurnCompleted([{ role: "assistant", content: [], stopReason: "stop" }]),
    ).toThrow("empty assistant response");
  });

  it("accepts a normal assistant text response", () => {
    expect(() =>
      assertAssistantTurnCompleted([
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stopReason: "stop",
        },
      ]),
    ).not.toThrow();
  });
});
