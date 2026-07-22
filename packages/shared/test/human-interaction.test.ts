import { describe, expect, it } from "vitest";

import { HumanInteractionRecordSchema } from "../src/execution/human-interaction.schema.ts";

const base = {
  interactionId: "interaction",
  executionId: "execution",
  invocationId: "invocation",
  request: { kind: "question" as const, prompt: "What next?" },
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

describe("HumanInteractionRecordSchema", () => {
  it("requires a response exactly when the interaction is responded", () => {
    expect(HumanInteractionRecordSchema.safeParse({ ...base, status: "pending" }).success).toBe(
      true,
    );
    expect(
      HumanInteractionRecordSchema.safeParse({
        ...base,
        status: "responded",
        response: { answers: { "What next?": "Continue" } },
      }).success,
    ).toBe(true);
    expect(HumanInteractionRecordSchema.safeParse({ ...base, status: "responded" }).success).toBe(
      false,
    );
    expect(
      HumanInteractionRecordSchema.safeParse({
        ...base,
        status: "pending",
        response: { answers: {} },
      }).success,
    ).toBe(false);
  });
});
