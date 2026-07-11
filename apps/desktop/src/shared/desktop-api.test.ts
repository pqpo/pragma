import { describe, expect, it } from "vitest";

import {
  EXPERT_DESCRIPTION_MAX_LENGTH,
  EXPERT_ID_MAX_LENGTH,
  EXPERT_NAME_MAX_LENGTH,
  EXPERT_TAG_MAX_LENGTH,
  CreateExpertDefinitionSchema,
} from "./desktop-api.ts";

const validInput = {
  id: "expert_01",
  name: "Expert 01",
  description: "A focused expert.",
  tags: ["analysis"],
  version: "0.1.0",
  scope: "Focused analysis.",
  model: null,
  capabilities: [],
  toolApprovals: {},
  plugins: [],
  contextStoreMounts: [],
};

describe("expert input limits", () => {
  it("accepts an ID made from letters, numbers, and underscores", () => {
    expect(CreateExpertDefinitionSchema.safeParse(validInput).success).toBe(true);
  });

  it.each([
    ["id", { id: "invalid-id" }],
    ["id length", { id: "a".repeat(EXPERT_ID_MAX_LENGTH + 1) }],
    ["name length", { name: "a".repeat(EXPERT_NAME_MAX_LENGTH + 1) }],
    ["description length", { description: "a".repeat(EXPERT_DESCRIPTION_MAX_LENGTH + 1) }],
    ["tag length", { tags: ["a".repeat(EXPERT_TAG_MAX_LENGTH + 1)] }],
  ])("rejects invalid %s", (_label, override) => {
    expect(CreateExpertDefinitionSchema.safeParse({ ...validInput, ...override }).success).toBe(
      false,
    );
  });
});
