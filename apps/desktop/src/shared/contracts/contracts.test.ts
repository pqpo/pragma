import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";
import { PRAGMA_TEXT_LIMITS } from "@pragma/shared";

import {
  CreateExpertDefinitionSchema,
  CreateContextStoreSchema,
  CreateContextStoreFileSchema,
  ExpertDefinitionSchema,
  CodeServiceCapabilityDefinitionSchema,
  CapabilityTestResultSchema,
  CapabilityDeleteResultSchema,
  CreateMissionSchema,
  CreateMissionBranchSchema,
  DeleteContextStoreSchema,
  GetMissionChatSchema,
  HomeMissionExecutorCatalogSchema,
  MissionChatSnapshotSchema,
  MissionChatUpdateSchema,
  MissionCreationDefaultsSchema,
  MissionModelOptionsSchema,
  MissionSchema,
  MissionUpdateSchema,
  SendMissionMessageSchema,
  StageMissionClipboardImageSchema,
  PragmaProjectChangesSchema,
  RuntimeEnvironmentCatalogSchema,
  DesktopBridgeSnapshotSchema,
  DesktopSettingsSnapshotSchema,
  UpdateDesktopSettingsSchema,
  UpdateExpertDefinitionSchema,
  UpdateMissionOptionsSchema,
  UpdateHomeExecutorPreferenceSchema,
  UpdateBuiltInExpertDefinitionSchema,
  UpdateContextStoreFileSchema,
  DesktopGlobalMemoryPolicySnapshotSchema,
  DesktopAssetMemoryPolicySnapshotSchema,
  DesktopMemoryPlaneStatusSchema,
  DesktopMemoryExtractionTaskSchema,
  DesktopMemoryItemSchema,
  UpdateDesktopAssetMemoryPolicySchema,
} from "./index.ts";

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

describe("desktop memory contracts", () => {
  it("defaults missing subject names for backward-compatible memory item IPC", () => {
    expect(
      DesktopMemoryItemSchema.parse({
        module: "episodic",
        id: "episode-a",
        revision: 1,
        status: "active",
        title: "Release",
        summary: "Released successfully.",
        rootRefs: [{ type: "pragma.expert-team", id: "team-a" }],
        producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
        evidenceRefs: [],
        visibility: { mode: "host-private" },
        sensitivity: "internal",
        bindings: [],
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
        executionId: "execution-a",
        goal: "Release",
        outcome: "succeeded",
        valueScore: 0.9,
        attempts: [],
        failuresAndRecoveries: [],
      }).subjectNames,
    ).toEqual({});
  });

  it("validates versioned global and asset policy snapshots", () => {
    expect(
      DesktopGlobalMemoryPolicySnapshotSchema.parse({
        revision: 1,
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        policy: {
          enabled: "enabled",
          capture: "enabled",
          recall: "enabled",
          learning: "local-candidates",
        },
      }),
    ).toMatchObject({ revision: 1, policy: { capture: "enabled" } });
    expect(
      DesktopAssetMemoryPolicySnapshotSchema.parse({
        targetRef: { type: "pragma.expert-team", id: "review-team" },
        revision: 0,
        effectiveFrom: "1970-01-01T00:00:00.000Z",
        policy: { capture: "inherit", recall: "disabled", learning: "inherit" },
        effective: {
          capture: true,
          recall: false,
          learning: "local-candidates",
          appliedRevisions: [{ scope: "global", revision: 0 }],
        },
      }),
    ).toMatchObject({ targetRef: { type: "pragma.expert-team" }, effective: { recall: false } });
    expect(
      UpdateDesktopAssetMemoryPolicySchema.safeParse({
        targetRef: { type: "pragma.project", id: "project" },
        expectedRevision: 0,
        policy: { capture: "inherit", recall: "inherit", learning: "inherit" },
      }).success,
    ).toBe(false);
  });

  it("exposes bounded plane health without sensitive payloads", () => {
    expect(
      DesktopMemoryPlaneStatusSchema.parse({
        state: "running",
        feed: { lastSequence: 12, eventCount: 10 },
        delivery: { pending: 1, quarantined: 0 },
        modules: [],
      }),
    ).toMatchObject({
      state: "running",
      feed: { lastSequence: 12, eventCount: 10 },
      delivery: { pending: 1, quarantined: 0 },
      modules: [],
    });
  });

  it("keeps extraction completion and problem details in their matching lanes", () => {
    const base = {
      module: "episodic" as const,
      id: "job-a",
      revision: 1,
      updatedAt: "2026-08-05T08:00:00.000Z",
    };
    expect(
      DesktopMemoryExtractionTaskSchema.safeParse({
        ...base,
        lane: "completed",
        completion: "rejected",
      }).success,
    ).toBe(true);
    expect(
      DesktopMemoryExtractionTaskSchema.safeParse({
        ...base,
        lane: "attention",
        problem: { kind: "invalid_output", technicalCode: "extractor_output_invalid" },
      }).success,
    ).toBe(true);
    expect(
      DesktopMemoryExtractionTaskSchema.safeParse({
        ...base,
        lane: "waiting",
        completion: "rejected",
      }).success,
    ).toBe(false);
    expect(
      DesktopMemoryExtractionTaskSchema.safeParse({
        ...base,
        lane: "running",
        problem: { kind: "runtime", technicalCode: "memory_curator_timeout" },
      }).success,
    ).toBe(false);
  });
});

describe("runtime settings contracts", () => {
  it("uses the fixed-default Runtime catalog without a mutable default field", () => {
    expect(
      RuntimeEnvironmentCatalogSchema.parse({
        schemaVersion: "pragma.runtime-environment-catalog/v2",
        entries: [],
      }),
    ).toEqual({ schemaVersion: "pragma.runtime-environment-catalog/v2", entries: [] });
    expect(
      RuntimeEnvironmentCatalogSchema.safeParse({
        schemaVersion: "pragma.runtime-environment-catalog/v1",
        defaultRuntimeId: "codex",
        entries: [],
      }).success,
    ).toBe(false);
  });

  it("preserves arbitrary Interpreter capability lists for renderer compatibility checks", () => {
    const snapshot = {
      app: {
        name: "Pragma",
        version: "1.0.0",
        os: "macos",
      },
      startup: {
        status: "ready",
      },
      interpreter: {
        writeVersion: "pragma.dsl/v8",
        directReadVersions: ["pragma.dsl/v8"],
        upgradeFromVersions: [
          "pragma.dsl/v2",
          "pragma.dsl/v3",
          "pragma.dsl/v4",
          "pragma.dsl/v5",
          "pragma.dsl/v6",
        ],
      },
      gateway: {
        schemaVersion: 1,
        endpoint: "ws://localhost:3001/runtime-gateway",
        transport: "websocket",
      },
      device: {
        status: "offline",
        label: "Local Desktop",
      },
      workspace: {
        path: null,
        status: "unset",
      },
      capabilities: [],
    } as const;

    expect(DesktopBridgeSnapshotSchema.parse(snapshot).interpreter).toEqual(snapshot.interpreter);
    expect(
      DesktopBridgeSnapshotSchema.parse({
        ...snapshot,
        startup: {
          status: "failed",
          code: "DESKTOP_MAIN_INITIALIZATION_FAILED",
        },
      }).startup,
    ).toEqual({
      status: "failed",
      code: "DESKTOP_MAIN_INITIALIZATION_FAILED",
    });
    expect(
      DesktopBridgeSnapshotSchema.safeParse({
        ...snapshot,
        startup: {
          status: "failed",
          code: "DESKTOP_MAIN_INITIALIZATION_FAILED",
          error: "private stack",
        },
      }).success,
    ).toBe(false);
    expect(
      DesktopBridgeSnapshotSchema.safeParse({
        ...snapshot,
        interpreter: {
          writeVersion: "pragma.dsl/v8",
          directReadVersions: ["pragma.dsl/v8"],
          upgradeFromVersions: [],
        },
      }).success,
    ).toBe(true);
    expect(
      DesktopBridgeSnapshotSchema.parse({ ...snapshot, interpreter: undefined }),
    ).toMatchObject({
      app: snapshot.app,
    });
  });
});

describe("Pragma project change-set contracts", () => {
  it("requires at least one upsert and defaults removals", () => {
    const resource = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile" as const,
      metadata: {
        id: "hct7g5mmh9vzz5tt",
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
        baseRevision: 3,
        upserts: [resource],
      }),
    ).toMatchObject({ baseRevision: 3, removals: [], requiredUnchangedRefs: [] });
    expect(PragmaProjectChangesSchema.safeParse({ baseRevision: 3, upserts: [] }).success).toBe(
      false,
    );
  });
});

describe("mission model override contracts", () => {
  const mission = {
    workspace: "/workspace/default",
    executor: { ref: "expert:2qgbztga4kz2qz51" },
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
  it("carries at most ten recent workspaces", () => {
    const recentWorkspaces = Array.from({ length: 10 }, (_, index) => ({
      path: `/workspace/recent-${index}`,
      basename: `recent-${index}`,
    }));
    expect(
      MissionCreationDefaultsSchema.parse({
        workspace: { path: "/workspace/default", basename: "default" },
        recentWorkspaces,
        executorRef: "expert:2qgbztga4kz2qz51",
        toolPermissionMode: "request-approval",
      }).recentWorkspaces,
    ).toEqual(recentWorkspaces);
    expect(
      MissionCreationDefaultsSchema.safeParse({
        workspace: { path: "/workspace/default", basename: "default" },
        recentWorkspaces: [...recentWorkspaces, { path: "/workspace/eleven", basename: "eleven" }],
        executorRef: "expert:2qgbztga4kz2qz51",
        toolPermissionMode: "request-approval",
      }).success,
    ).toBe(false);
  });
});

describe("Home executor preference contracts", () => {
  it("validates a workspace-aware catalog and requires a concrete preference mutation", () => {
    expect(
      HomeMissionExecutorCatalogSchema.parse({
        executors: [
          {
            ref: "expert:0000000000000001",
            name: "Coder",
            description: "Codes",
            kind: "expert",
            origin: "project",
            readOnly: false,
            customized: false,
            tags: ["code"],
            teamMemberships: [],
            preference: {
              favoriteScope: "workspace",
              hidden: false,
              favoriteWorkspace: { path: "/work/favorite", basename: "favorite" },
              lastWorkspace: { path: "/work/code", basename: "code" },
            },
            alwaysVisible: false,
          },
        ],
        defaults: {
          workspace: { path: "/work/default", basename: "default" },
          recentWorkspaces: [],
          executorRef: "expert:0000000000000001",
          toolPermissionMode: "request-approval",
        },
      }).executors[0]?.tags,
    ).toEqual(["code"]);
    expect(
      UpdateHomeExecutorPreferenceSchema.safeParse({ ref: "expert:0000000000000001" }).success,
    ).toBe(false);
    expect(
      UpdateHomeExecutorPreferenceSchema.safeParse({
        ref: "expert:0000000000000001",
        favoriteScope: "workspace",
        favoriteWorkspace: "/work/code",
      }).success,
    ).toBe(true);
    expect(
      UpdateHomeExecutorPreferenceSchema.safeParse({
        ref: "expert:0000000000000001",
        favoriteScope: "workspace",
      }).success,
    ).toBe(false);
    expect(
      UpdateHomeExecutorPreferenceSchema.safeParse({
        ref: "expert:0000000000000001",
        favoriteWorkspace: "/work/code",
      }).success,
    ).toBe(false);
    expect(
      UpdateHomeExecutorPreferenceSchema.safeParse({
        ref: "expert:0000000000000001",
        favoriteScope: "global",
        hidden: true,
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
    expect(
      MissionChatUpdateSchema.parse({
        kind: "patch",
        missionId,
        revision: 2,
        patches: [
          {
            type: "context-window.update",
            usage: {
              usedTokens: 64_000,
              contextWindowTokens: 128_000,
              percent: 50,
              measurement: "estimated",
              observedAt: "2026-07-29T00:00:00.000Z",
            },
          },
        ],
      }),
    ).toMatchObject({
      patches: [{ type: "context-window.update", usage: { usedTokens: 64_000 } }],
    });
    expect(MissionChatUpdateSchema.parse({ kind: "invalidate", missionId, revision: 3 })).toEqual({
      kind: "invalidate",
      missionId,
      revision: 3,
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

describe("mission update contracts", () => {
  it("supports typed Mission upserts and removals", () => {
    const missionId = "00000000-0000-4000-8000-000000000000";
    expect(MissionUpdateSchema.parse({ kind: "remove", missionId })).toEqual({
      kind: "remove",
      missionId,
    });
    expect(MissionUpdateSchema.safeParse({ kind: "remove", missionId: "" }).success).toBe(false);
  });
});

describe("context store delete contracts", () => {
  it("requires a context store UUID", () => {
    expect(
      DeleteContextStoreSchema.parse({ storeId: "00000000-0000-4000-8000-000000000000" }),
    ).toEqual({ storeId: "00000000-0000-4000-8000-000000000000" });
    expect(DeleteContextStoreSchema.safeParse({ storeId: "notes" }).success).toBe(false);
  });

  it("only accepts blank or copied-import knowledge base creation", () => {
    expect(
      CreateContextStoreSchema.parse({
        mode: "blank",
        name: "Docs",
        description: "",
      }),
    ).toEqual({ mode: "blank", name: "Docs", description: "" });
    expect(
      CreateContextStoreSchema.parse({
        mode: "import",
        name: "Docs",
        description: "",
        sourcePath: "/tmp/docs",
      }),
    ).toMatchObject({ mode: "import", sourcePath: "/tmp/docs" });
    expect(CreateContextStoreSchema.safeParse({ type: "note", name: "Notes" }).success).toBe(false);
  });

  it("requires Markdown paths and optimistic revisions for file edits", () => {
    const storeId = "00000000-0000-4000-8000-000000000000";
    expect(CreateContextStoreFileSchema.parse({ storeId, id: "guides/review.md" })).toMatchObject({
      content: "",
    });
    expect(
      UpdateContextStoreFileSchema.safeParse({
        storeId,
        id: "guides/review.md",
        content: "Updated",
        metadata: { trigger: "manual", priority: "normal" },
      }).success,
    ).toBe(false);
  });
});

const validInput = {
  baseRevision: 0,
  requiredUnchangedRefs: [],
  name: "Expert 01",
  description: "A focused expert.",
  tags: ["analysis"],
  scope: "Focused analysis.",
  instructions: "Analyze the supplied work.",
  model: { runtimeId: "test", providerId: "test", modelId: "test" },
  capabilities: [],
  toolApprovals: {},
  plugins: [],
  contextStoreMounts: [],
};

describe("expert input limits", () => {
  it("accepts an Expert create input without a caller-provided ID", () => {
    expect(CreateExpertDefinitionSchema.safeParse(validInput).success).toBe(true);
  });

  it("rejects a caller-provided Expert ID", () => {
    expect(
      CreateExpertDefinitionSchema.safeParse({
        ...validInput,
        id: "a".repeat(16),
      }).success,
    ).toBe(false);
  });

  it("does not allow an ordinary Expert update to change the resource version", () => {
    const { requiredUnchangedRefs: _requiredUnchangedRefs, ...input } = validInput;
    void _requiredUnchangedRefs;

    expect(
      UpdateExpertDefinitionSchema.safeParse({
        ...input,
        baseRevision: 2,
        version: "2.0.0",
      }).success,
    ).toBe(false);
  });

  it("reads Expert metadata at the shared limits", () => {
    const id = "a".repeat(16);
    expect(
      ExpertDefinitionSchema.safeParse({
        schemaVersion: "pragma.desktop-expert-view/v1",
        ref: `expert:${id}`,
        id,
        name: "n".repeat(PRAGMA_TEXT_LIMITS.expert.name),
        description: "d".repeat(PRAGMA_TEXT_LIMITS.expert.description),
        tags: Array.from({ length: PRAGMA_TEXT_LIMITS.expert.tags }, (_, index) => `tag_${index}`),
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
    ["id length", { id: "a".repeat(16 + 1) }],
    ["name length", { name: "a".repeat(PRAGMA_TEXT_LIMITS.expert.name + 1) }],
    ["description length", { description: "a".repeat(PRAGMA_TEXT_LIMITS.expert.description + 1) }],
    ["scope length", { scope: "a".repeat(PRAGMA_TEXT_LIMITS.expert.scope + 1) }],
    [
      "instructions length",
      { instructions: "a".repeat(PRAGMA_TEXT_LIMITS.expert.instructions + 1) },
    ],
    ["missing instructions", { instructions: "" }],
    ["missing model", { model: null }],
    ["tag length", { tags: ["a".repeat(PRAGMA_TEXT_LIMITS.expert.tag + 1)] }],
    [
      "tag count",
      {
        tags: Array.from(
          { length: PRAGMA_TEXT_LIMITS.expert.tags + 1 },
          (_, index) => `tag${index}`,
        ),
      },
    ],
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
          schemaVersion: "pragma.capability/v2",
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
  it("requires optimistic source identifiers when creating a Mission branch", () => {
    const input = {
      sourceMissionId: "00000000-0000-4000-8000-000000000001",
      expectedExecutionId: "00000000-0000-4000-8000-000000000002",
      expectedMessageId: "assistant:final",
    };

    expect(CreateMissionBranchSchema.parse(input)).toEqual(input);
    expect(
      CreateMissionBranchSchema.safeParse({ ...input, expectedExecutionId: "stale" }).success,
    ).toBe(false);
  });

  it("accepts attachments on follow-up messages and validates pasted images", () => {
    const attachment = {
      id: "00000000-0000-4000-8000-000000000002",
      kind: "image" as const,
      name: "pasted-image.png",
      path: "/tmp/pasted-image.png",
      mimeType: "image/png",
      optimized: {
        path: "/tmp/pasted-image.optimized.webp",
        mimeType: "image/webp",
        size: 120_000,
      },
    };
    expect(
      SendMissionMessageSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
        content: "Review this image.",
        requestId: "00000000-0000-4000-8000-000000000003",
        attachments: [attachment],
      }).attachments,
    ).toEqual([attachment]);
    expect(
      StageMissionClipboardImageSchema.safeParse({
        name: "pasted-image.png",
        mimeType: "image/png",
        data: "aW1hZ2U=",
      }).success,
    ).toBe(true);
    expect(
      StageMissionClipboardImageSchema.safeParse({
        name: "pasted-image.bmp",
        mimeType: "image/bmp",
        data: "not base64!",
      }).success,
    ).toBe(false);
    expect(
      SendMissionMessageSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        content: "Review this file.",
        requestId: "00000000-0000-4000-8000-000000000003",
        attachments: [{ ...attachment, kind: "file", mimeType: undefined }],
      }).success,
    ).toBe(false);
  });

  it("accepts versioned expert, team, and flow resource references", () => {
    const input = {
      workspace: "/workspace/repo",
      executor: { ref: "expert:kp8tkn2szy1xhpb5" },
      input: { kind: "prompt", value: "Review the repository" },
    };
    expect(CreateMissionSchema.safeParse(input).success).toBe(true);
    const contextStoreId = "10000000-0000-4000-8000-000000000001";
    expect(
      CreateMissionSchema.parse({ ...input, contextStoreIds: [contextStoreId] }).contextStoreIds,
    ).toEqual([contextStoreId]);
    expect(
      CreateMissionSchema.safeParse({
        ...input,
        contextStoreIds: [contextStoreId, contextStoreId],
      }).success,
    ).toBe(false);
    expect(
      CreateMissionSchema.parse({ ...input, toolPermissionMode: "full-access" }).toolPermissionMode,
    ).toBe("full-access");
    expect(
      CreateMissionSchema.safeParse({ ...input, toolPermissionMode: "unrestricted" }).success,
    ).toBe(false);
    expect(
      CreateMissionSchema.safeParse({
        ...input,
        executor: { ref: "team:vyv9pwwzaksth2dd" },
      }).success,
    ).toBe(true);
    expect(
      CreateMissionSchema.safeParse({ ...input, executor: { ref: "not-a-ref" } }).success,
    ).toBe(false);
    expect(
      CreateMissionSchema.safeParse({
        ...input,
        executor: { ref: "capability:d5th62nhdaaeqe21" },
      }).success,
    ).toBe(false);
    expect(
      CreateMissionSchema.safeParse({
        ...input,
        executor: { ref: "runtime-profile:mx0xj2gjcvhcccwx" },
      }).success,
    ).toBe(false);
  });

  it("pins a team executor to a project revision", () => {
    expect(
      MissionSchema.parse({
        schemaVersion: "pragma.mission/v9",
        id: "00000000-0000-4000-8000-000000000000",
        title: "Deliver the feature",
        goal: "Deliver the feature",
        initialMessageId: "00000000-0000-4000-8000-000000000001",
        workspace: { path: "/workspace/repo", basename: "repo" },
        project: { id: "studio", revision: 3 },
        executor: {
          kind: "team",
          ref: "team:gmpsevbrb8danedb",
          name: "Delivery Team",
        },
        contextStoreIds: [],
        lifecycleStatus: "active",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      }).toolPermissionMode,
    ).toBe("request-approval");
  });

  it("drops the retired Desktop environment fingerprint from persisted Missions", () => {
    const parsed = MissionSchema.parse({
      schemaVersion: "pragma.mission/v9",
      id: "00000000-0000-4000-8000-000000000000",
      title: "Continue the mission",
      goal: "Continue the mission",
      initialMessageId: "00000000-0000-4000-8000-000000000001",
      workspace: { path: "/workspace/repo", basename: "repo" },
      project: { id: "studio", revision: 3 },
      executor: {
        kind: "expert",
        ref: "expert:1xddvess309a6gme",
        name: "Writer",
      },
      contextStoreIds: [],
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
        syncIssues: [
          {
            code: "execution_state_unavailable",
            section: "history",
            retryable: true,
          },
        ],
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
