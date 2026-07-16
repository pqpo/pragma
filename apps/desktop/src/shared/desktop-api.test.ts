import { describe, expect, it } from "vitest";

import {
  EXPERT_DESCRIPTION_MAX_LENGTH,
  EXPERT_ID_MAX_LENGTH,
  EXPERT_NAME_MAX_LENGTH,
  EXPERT_TAG_MAX_LENGTH,
  CreateExpertDefinitionSchema,
  CodeServiceCapabilityDefinitionSchema,
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

describe("code service contracts", () => {
  const definition = {
    kind: "code_service" as const,
    name: "Formatter",
    description: "Format records.",
    language: "javascript" as const,
    timeoutMs: 2_000,
    tool: {
      name: "format_records",
      description: "Format records.",
      inputSchema: {
        type: "object" as const,
        properties: {
          records: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: { id: { type: "string" as const } },
              required: ["id"],
              additionalProperties: false as const,
            },
          },
        },
        required: ["records"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: { count: { type: "integer" as const } },
        required: ["count"],
        additionalProperties: false as const,
      },
      source: "function main(input) { return { count: input.records.length }; }",
    },
  };

  it("accepts recursive object and array schemas", () => {
    expect(CodeServiceCapabilityDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it("rejects required fields that are not declared", () => {
    expect(
      CodeServiceCapabilityDefinitionSchema.safeParse({
        ...definition,
        tool: {
          ...definition.tool,
          outputSchema: { ...definition.tool.outputSchema, required: ["missing"] },
        },
      }).success,
    ).toBe(false);
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
