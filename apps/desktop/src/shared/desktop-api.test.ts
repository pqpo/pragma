import { describe, expect, it } from "vitest";

import {
  EXPERT_DESCRIPTION_MAX_LENGTH,
  PRAGMA_EXPERT_ID_MAX_LENGTH,
  EXPERT_INSTRUCTIONS_MAX_LENGTH,
  EXPERT_NAME_MAX_LENGTH,
  EXPERT_SCOPE_MAX_LENGTH,
  EXPERT_TAG_MAX_LENGTH,
  CreateExpertDefinitionSchema,
  ExpertDefinitionSchema,
  CodeServiceCapabilityDefinitionSchema,
  CapabilityTestResultSchema,
  CapabilityDeleteResultSchema,
  CreateMissionSchema,
  DeleteContextStoreSchema,
  GetMissionChatSchema,
  MissionChatSnapshotSchema,
  MissionChatUpdateSchema,
  MissionCreationDefaultsSchema,
  MissionModelOptionsSchema,
  MissionSchema,
  PragmaProjectChangesSchema,
  SetDefaultRuntimeSchema,
  DesktopSettingsSnapshotSchema,
  UpdateDesktopSettingsSchema,
  UpdateMissionOptionsSchema,
  UpdateBuiltInExpertDefinitionSchema,
} from "./desktop-api.ts";

describe("desktop settings contracts", () => {
  it("accepts supported language preferences and rejects arbitrary locale tags", () => {
    expect(UpdateDesktopSettingsSchema.parse({ localePreference: "system" })).toEqual({
      localePreference: "system",
    });
    expect(UpdateDesktopSettingsSchema.parse({ defaultWorkspace: "/workspace/default" })).toEqual({
      defaultWorkspace: "/workspace/default",
    });
    expect(UpdateDesktopSettingsSchema.parse({ toolPermissionMode: "full-access" })).toEqual({
      toolPermissionMode: "full-access",
    });
    expect(UpdateDesktopSettingsSchema.safeParse({}).success).toBe(false);
    expect(
      DesktopSettingsSnapshotSchema.parse({
        schemaVersion: 1,
        localePreference: "zh-Hant",
        toolPermissionMode: "request-approval",
        defaultWorkspace: "/workspace/default",
        usesBuiltInDefaultWorkspace: false,
        resolvedLocale: "zh-Hant",
      }),
    ).toMatchObject({
      defaultWorkspace: "/workspace/default",
      usesBuiltInDefaultWorkspace: false,
      resolvedLocale: "zh-Hant",
    });
    expect(UpdateDesktopSettingsSchema.safeParse({ localePreference: "fr" }).success).toBe(false);
  });
});

describe("runtime settings contracts", () => {
  it("requires a concrete Runtime ID", () => {
    expect(SetDefaultRuntimeSchema.parse({ runtimeId: "codex" })).toEqual({
      runtimeId: "codex",
    });
    expect(SetDefaultRuntimeSchema.safeParse({ runtimeId: "" }).success).toBe(false);
  });
});

describe("Pragma project change-set contracts", () => {
  it("requires at least one upsert and defaults removals", () => {
    const resource = {
      apiVersion: "pragma/v2" as const,
      kind: "RuntimeProfile" as const,
      metadata: {
        id: "flow_runtime",
        version: "1.0.0",
        name: "Flow Runtime",
        description: "Flow Runtime",
        tags: ["flow-runtime-override"],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "codex" },
      },
    };
    expect(
      PragmaProjectChangesSchema.parse({
        expectedRevision: 3,
        upserts: [resource],
      }),
    ).toMatchObject({ expectedRevision: 3, removals: [] });
    expect(PragmaProjectChangesSchema.safeParse({ expectedRevision: 3, upserts: [] }).success).toBe(
      false,
    );
  });
});

describe("mission model override contracts", () => {
  const mission = {
    workspace: "/workspace/default",
    executor: { ref: "expert:pragma@1.0.0" },
    input: { kind: "prompt", value: "Prepare a plan" },
  };

  it("accepts a model-only override", () => {
    expect(
      CreateMissionSchema.safeParse({
        ...mission,
        modelOverride: { providerId: "provider", modelId: "model", thinkingLevel: "high" },
      }).success,
    ).toBe(true);
  });

  it("rejects attempts to switch Runtime from Home", () => {
    expect(
      CreateMissionSchema.safeParse({
        ...mission,
        modelOverride: { runtimeId: "codex", providerId: "provider", modelId: "model" },
      }).success,
    ).toBe(false);
  });

  it("supports replacing or clearing persisted Mission options", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(
      UpdateMissionOptionsSchema.parse({
        id,
        toolPermissionMode: "auto-approve",
        modelOverride: { providerId: "provider", modelId: "model", thinkingLevel: "high" },
      }),
    ).toMatchObject({ toolPermissionMode: "auto-approve" });
    expect(
      UpdateMissionOptionsSchema.parse({
        id,
        toolPermissionMode: "request-approval",
        modelOverride: null,
      }).modelOverride,
    ).toBeNull();
  });

  it("represents provider reset requirements without rejecting model option loading", () => {
    expect(
      MissionModelOptionsSchema.parse({
        status: "reset_required",
        runtime: { id: "codex", displayName: "Codex" },
        models: [],
      }),
    ).toEqual({
      status: "reset_required",
      runtime: { id: "codex", displayName: "Codex" },
      models: [],
    });
  });

  it("carries the asynchronously resolved executor model defaults", () => {
    expect(
      MissionModelOptionsSchema.parse({
        status: "ready",
        runtime: { id: "codex", displayName: "Codex" },
        models: [],
        defaultSelection: {
          providerId: "provider",
          modelId: "model",
          thinkingLevel: "high",
        },
      }).defaultSelection,
    ).toEqual({ providerId: "provider", modelId: "model", thinkingLevel: "high" });
  });
});

describe("mission creation defaults contracts", () => {
  it("carries at most five recent workspaces", () => {
    const recentWorkspaces = Array.from({ length: 5 }, (_, index) => ({
      path: `/workspace/recent-${index}`,
      basename: `recent-${index}`,
    }));
    expect(
      MissionCreationDefaultsSchema.parse({
        workspace: { path: "/workspace/default", basename: "default" },
        recentWorkspaces,
        executorRef: "expert:pragma@1.0.0",
        toolPermissionMode: "request-approval",
      }).recentWorkspaces,
    ).toEqual(recentWorkspaces);
    expect(
      MissionCreationDefaultsSchema.safeParse({
        workspace: { path: "/workspace/default", basename: "default" },
        recentWorkspaces: [...recentWorkspaces, { path: "/workspace/six", basename: "six" }],
        executorRef: "expert:pragma@1.0.0",
        toolPermissionMode: "request-approval",
      }).success,
    ).toBe(false);
  });
});

describe("mission chat streaming contracts", () => {
  it("accepts incremental patches and invalidations with positive revisions", () => {
    const missionId = "00000000-0000-4000-8000-000000000000";
    expect(
      MissionChatUpdateSchema.parse({
        kind: "patch",
        missionId,
        revision: 1,
        patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "hello" }],
      }),
    ).toMatchObject({ kind: "patch", revision: 1 });
    expect(MissionChatUpdateSchema.parse({ kind: "invalidate", missionId, revision: 2 })).toEqual({
      kind: "invalidate",
      missionId,
      revision: 2,
    });
    expect(
      MissionChatUpdateSchema.safeParse({
        kind: "patch",
        missionId,
        revision: 0,
        patches: [],
      }).success,
    ).toBe(false);
  });
});

describe("context store delete contracts", () => {
  it("requires a context store UUID", () => {
    expect(
      DeleteContextStoreSchema.parse({ storeId: "00000000-0000-4000-8000-000000000000" }),
    ).toEqual({ storeId: "00000000-0000-4000-8000-000000000000" });
    expect(DeleteContextStoreSchema.safeParse({ storeId: "notes" }).success).toBe(false);
  });
});

const validInput = {
  id: "expert_01",
  name: "Expert 01",
  description: "A focused expert.",
  tags: ["analysis"],
  version: "0.1.0",
  scope: "Focused analysis.",
  instructions: "Analyze the supplied work.",
  model: { runtimeId: "test", providerId: "test", modelId: "test" },
  capabilities: [],
  toolApprovals: {},
  plugins: [],
  contextStoreMounts: [],
};

describe("expert input limits", () => {
  it("accepts an ID made from letters, numbers, and underscores", () => {
    expect(CreateExpertDefinitionSchema.safeParse(validInput).success).toBe(true);
  });

  it("accepts exactly 50 Expert ID characters", () => {
    expect(
      CreateExpertDefinitionSchema.safeParse({
        ...validInput,
        id: "a".repeat(PRAGMA_EXPERT_ID_MAX_LENGTH),
      }).success,
    ).toBe(true);
  });

  it("reads every metadata value accepted by the Expert DSL", () => {
    const id = "a".repeat(PRAGMA_EXPERT_ID_MAX_LENGTH);
    expect(
      ExpertDefinitionSchema.safeParse({
        schemaVersion: "pragma.desktop-expert-view/v1",
        ref: `expert:${id}@1.0.0`,
        id,
        name: "n".repeat(200),
        description: "d".repeat(4_000),
        tags: Array.from({ length: 100 }, (_, index) => `tag_${index}`),
        version: "1.0.0",
        scope: "Scope",
        instructions: "Instructions",
        additionalInstructions: "",
        origin: "project",
        readOnly: false,
        customized: false,
        executionProfile: {
          mode: "pinned",
          model: { runtimeId: "test", providerId: "test", modelId: "test" },
        },
        capabilities: [],
        toolApprovals: {},
        plugins: [],
        contextStoreMounts: [],
        resourceTools: [],
        revision: 1,
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["id", { id: "invalid-id" }],
    ["id length", { id: "a".repeat(PRAGMA_EXPERT_ID_MAX_LENGTH + 1) }],
    ["name length", { name: "a".repeat(EXPERT_NAME_MAX_LENGTH + 1) }],
    ["description length", { description: "a".repeat(EXPERT_DESCRIPTION_MAX_LENGTH + 1) }],
    ["scope length", { scope: "a".repeat(EXPERT_SCOPE_MAX_LENGTH + 1) }],
    ["instructions length", { instructions: "a".repeat(EXPERT_INSTRUCTIONS_MAX_LENGTH + 1) }],
    ["missing instructions", { instructions: "" }],
    ["missing model", { model: null }],
    ["tag length", { tags: ["a".repeat(EXPERT_TAG_MAX_LENGTH + 1)] }],
  ])("rejects invalid %s", (_label, override) => {
    expect(CreateExpertDefinitionSchema.safeParse({ ...validInput, ...override }).success).toBe(
      false,
    );
  });
});

describe("built-in expert customization contracts", () => {
  const customization = {
    name: "My Pragma",
    description: "A customized built-in expert.",
    tags: ["customized"],
    additionalInstructions: "Prefer concise answers.",
    capabilities: [],
    toolApprovals: {},
    plugins: [],
    contextStoreMounts: [],
  };

  it("accepts only the user customization layer", () => {
    expect(UpdateBuiltInExpertDefinitionSchema.safeParse(customization).success).toBe(true);
    expect(
      UpdateBuiltInExpertDefinitionSchema.safeParse({
        ...customization,
        scope: "Replace the system-owned scope.",
      }).success,
    ).toBe(false);
    expect(
      UpdateBuiltInExpertDefinitionSchema.safeParse({
        ...customization,
        instructions: "Replace the system-owned foundation.",
      }).success,
    ).toBe(false);
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
      input: { kind: "prompt", value: "Review the repository" },
    };
    expect(CreateMissionSchema.safeParse(input).success).toBe(true);
    expect(
      CreateMissionSchema.parse({ ...input, toolPermissionMode: "full-access" }).toolPermissionMode,
    ).toBe("full-access");
    expect(
      CreateMissionSchema.safeParse({ ...input, toolPermissionMode: "unrestricted" }).success,
    ).toBe(false);
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
      MissionSchema.parse({
        schemaVersion: "pragma.mission/v4",
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
      }).toolPermissionMode,
    ).toBe("request-approval");
  });

  it("drops the retired Desktop environment fingerprint from persisted Missions", () => {
    const parsed = MissionSchema.parse({
      schemaVersion: "pragma.mission/v4",
      id: "00000000-0000-4000-8000-000000000000",
      title: "Continue the mission",
      goal: "Continue the mission",
      initialMessageId: "00000000-0000-4000-8000-000000000001",
      workspace: { path: "/workspace/repo", basename: "repo" },
      project: { id: "studio", revision: 3 },
      executor: {
        kind: "expert",
        ref: "expert:writer@1.0.0",
        name: "Writer",
        version: "1.0.0",
      },
      execution: {
        id: "00000000-0000-4000-8000-000000000002",
        inputMessageId: "00000000-0000-4000-8000-000000000001",
        environmentFingerprint: "a".repeat(64),
        status: "succeeded",
        startedAt: "2026-07-11T00:00:00.000Z",
        finishedAt: "2026-07-11T00:01:00.000Z",
      },
      lifecycleStatus: "active",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:01:00.000Z",
    });

    expect(parsed.execution).not.toHaveProperty("environmentFingerprint");
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
        contextWindow: {
          supportsInspection: true,
          supportsCompaction: true,
          canCompact: false,
          usage: {
            usedTokens: 64_000,
            contextWindowTokens: 128_000,
            percent: 50,
            measurement: "estimated",
            observedAt: "2026-07-11T00:00:03.000Z",
          },
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
