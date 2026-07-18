import { describe, expect, it } from "vitest";

import {
  EXPERT_DESCRIPTION_MAX_LENGTH,
  EXPERT_ID_MAX_LENGTH,
  EXPERT_NAME_MAX_LENGTH,
  EXPERT_TAG_MAX_LENGTH,
  CreateExpertDefinitionSchema,
  CodeServiceCapabilityDefinitionSchema,
  CapabilityTestResultSchema,
  CapabilityDeleteResultSchema,
  CreateMissionSchema,
  GetMissionChatSchema,
  MissionChatSnapshotSchema,
  MissionSchema,
  DesktopSettingsSnapshotSchema,
  UpdateDesktopSettingsSchema,
} from "./desktop-api.ts";

describe("desktop settings contracts", () => {
  it("accepts supported language preferences and rejects arbitrary locale tags", () => {
    expect(UpdateDesktopSettingsSchema.parse({ localePreference: "system" })).toEqual({
      localePreference: "system",
    });
    expect(
      DesktopSettingsSnapshotSchema.parse({
        schemaVersion: 1,
        localePreference: "zh-Hant",
        resolvedLocale: "zh-Hant",
      }),
    ).toMatchObject({ resolvedLocale: "zh-Hant" });
    expect(UpdateDesktopSettingsSchema.safeParse({ localePreference: "fr" }).success).toBe(false);
  });
});

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

describe("capability test contracts", () => {
  it("accepts text, arrays, and objects as tool output", () => {
    const base = {
      ok: true,
      code: "success",
      message: "Succeeded.",
      capability: {
        manifest: {
          schemaVersion: "pragma.capability/v1",
          id: "00000000-0000-4000-8000-000000000000",
          runtimeKey: "test_capability",
          name: "Test capability",
          kind: "code_service",
          latestRevision: 1,
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
        },
        health: { revision: 1, status: "ready", checkedAt: "2026-07-11T00:00:00.000Z" },
        definition: {
          kind: "code_service",
          name: "Test capability",
          description: "Test output shapes.",
          language: "javascript",
          timeoutMs: 2_000,
          tool: {
            name: "test_output",
            description: "Return output.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            outputSchema: { type: "object", properties: {}, additionalProperties: false },
            source: "function main() { return {}; }",
          },
        },
      },
    };

    expect(CapabilityTestResultSchema.safeParse({ ...base, output: "plain text" }).success).toBe(
      true,
    );
    expect(CapabilityTestResultSchema.safeParse({ ...base, output: ["one", "two"] }).success).toBe(
      true,
    );
  });
});

describe("capability delete contracts", () => {
  it("returns a stable code when an Expert still references the capability", () => {
    expect(
      CapabilityDeleteResultSchema.parse({ ok: false, code: "capability_referenced" }),
    ).toEqual({ ok: false, code: "capability_referenced" });
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
    expect(
      CreateMissionSchema.safeParse({
        ...input,
        executor: { ref: "capability:repository_tools@1.0.0" },
      }).success,
    ).toBe(false);
    expect(
      CreateMissionSchema.safeParse({
        ...input,
        executor: { ref: "runtime-profile:expert_runtime@1.0.0" },
      }).success,
    ).toBe(false);
  });

  it("pins a team executor to a project revision", () => {
    expect(
      MissionSchema.safeParse({
        schemaVersion: "pragma.mission/v3",
        id: "00000000-0000-4000-8000-000000000000",
        title: "Deliver the feature",
        goal: "Deliver the feature",
        initialMessageId: "00000000-0000-4000-8000-000000000001",
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

  it("validates rich chat entries and interruptible execution state", () => {
    expect(
      MissionChatSnapshotSchema.safeParse({
        missionId: "00000000-0000-4000-8000-000000000000",
        revision: 4,
        entries: [
          {
            id: "thinking:1",
            kind: "thinking",
            executionId: "execution-1",
            invocationId: "invocation-1",
            executorId: "writer",
            content: "Checking the workspace.",
            streaming: true,
            createdAt: "2026-07-11T00:00:01.000Z",
          },
          {
            id: "tool:execution-1:call-1",
            kind: "tool",
            executionId: "execution-1",
            invocationId: "invocation-1",
            toolCallId: "call-1",
            toolName: "read_file",
            status: "succeeded",
            inputPreview: '{"path":"README.md"}',
            outputPreview: "Pragma",
            createdAt: "2026-07-11T00:00:02.000Z",
          },
        ],
        page: { oldestSequence: 1, newestSequence: 1 },
        pendingInteractions: [],
        execution: {
          id: "00000000-0000-4000-8000-000000000010",
          status: "running",
          interruptible: true,
        },
      }).success,
    ).toBe(true);
  });

  it("defaults Mission chat pages to 50 turns and caps them at 100", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(GetMissionChatSchema.parse({ id }).limit).toBe(50);
    expect(GetMissionChatSchema.safeParse({ id, limit: 101 }).success).toBe(false);
  });
});
