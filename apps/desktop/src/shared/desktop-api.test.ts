import { describe, expect, it } from "vitest";

import {
  EXPERT_DESCRIPTION_MAX_LENGTH,
  EXPERT_ID_MAX_LENGTH,
  EXPERT_NAME_MAX_LENGTH,
  EXPERT_TAG_MAX_LENGTH,
  CreateExpertDefinitionSchema,
  CreateMissionSchema,
  MissionSchema,
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

describe("mission contracts", () => {
  it("accepts versioned expert, team, and flow resource references", () => {
    const input = {
      workspace: "/workspace/repo",
      executor: { ref: "expert:expert_01@1.0.0" },
      goal: "Review the repository",
    };
    expect(CreateMissionSchema.safeParse(input).success).toBe(true);
    expect(
      CreateMissionSchema.safeParse({
        ...input,
        executor: { ref: "team:delivery@1.0.0" },
      }).success,
    ).toBe(true);
    expect(
      CreateMissionSchema.safeParse({ ...input, executor: { ref: "not-a-ref" } }).success,
    ).toBe(false);
  });

  it("pins a team executor to a project revision", () => {
    expect(
      MissionSchema.safeParse({
        schemaVersion: "pragma.mission/v2",
        id: "00000000-0000-4000-8000-000000000000",
        title: "Deliver the feature",
        goal: "Deliver the feature",
        workspace: { path: "/workspace/repo", basename: "repo" },
        project: { id: "studio", revision: 3 },
        executor: {
          kind: "team",
          ref: "team:delivery_team@0.1.0",
          name: "Delivery Team",
          version: "0.1.0",
        },
        lifecycleStatus: "active",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
