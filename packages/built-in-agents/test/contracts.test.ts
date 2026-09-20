import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import {
  ContextStoreRevisionProfileSchema,
  ContextStoreChangeSetSchema,
  ContextStoreRevisionSnapshotSchema,
  SkillRevisionChangeSetSchema,
  PragmaAgentEvaluationDraftOperationSchema,
  PragmaAgentEvaluationDraftSchema,
  PragmaAgentFlowDraftOperationSchema,
  PragmaAgentFlowDraftSchema,
} from "../src/contracts.ts";
import {
  KnowledgeRevisionStartInputSchema,
  SkillRevisionStartInputSchema,
} from "../src/pragma-management-tools.ts";

describe("revision contracts", () => {
  it("accepts explicit creation metadata and rejects ambiguous revision starts", () => {
    for (const schema of [KnowledgeRevisionStartInputSchema, SkillRevisionStartInputSchema]) {
      expect(
        schema.safeParse({
          create: { name: "New resource", description: "Created through review." },
          prompt: "Create it.",
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          targetRef: "existing:target",
          create: { name: "New resource", description: "Ambiguous." },
          prompt: "Create it.",
        }).success,
      ).toBe(false);
      expect(schema.safeParse({ prompt: "Missing selector." }).success).toBe(false);
    }
  });

  it("keeps unknown historical model fields readable in v1 profiles", () => {
    const profile = ContextStoreRevisionProfileSchema.parse({
      schemaVersion: "pragma.context-store-revision-profile/v1",
      revision: 1,
      mode: "pinned",
      model: {
        runtimeId: "codex",
        providerId: "openai",
        modelId: "gpt-test",
        historicalHostField: "ignored",
      },
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    expect(profile.model).not.toHaveProperty("historicalHostField");
  });

  it("requires creation change sets to use revision 0 and revisions to use a formal base", () => {
    const contextChangeSet = {
      schemaVersion: "pragma.context-store-change-set/v2" as const,
      storeId: "10000000-0000-4000-8000-000000000001",
      baseSnapshotHash: "a".repeat(64),
      summary: "Update knowledge.",
      operations: [
        {
          operation: "upsert" as const,
          id: "items/fact.md",
          content: "# Fact\n",
          metadata: { trigger: "model_decision" as const, priority: "normal" as const },
        },
      ],
    };
    const skillChangeSet = {
      schemaVersion: "pragma.skill-revision-change-set/v2" as const,
      capabilityId: "20000000-0000-4000-8000-000000000001",
      baseContentHash: "b".repeat(64),
      name: "test-skill",
      description: "Test Skill.",
      summary: "Update Skill.",
      operations: [{ operation: "upsert" as const, path: "SKILL.md", content: "# Test\n" }],
    };

    for (const [schema, value] of [
      [ContextStoreChangeSetSchema, contextChangeSet],
      [SkillRevisionChangeSetSchema, skillChangeSet],
    ] as const) {
      expect(schema.safeParse({ ...value, operation: "create", baseRevision: 0 }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...value, operation: "create", baseRevision: 1 }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...value, operation: "revise", baseRevision: 1 }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...value, operation: "revise", baseRevision: 0 }).success).toBe(
        false,
      );
    }
  });

  it("keeps historical stored paths readable but enforces portable names for new files", () => {
    const snapshot = {
      schemaVersion: "pragma.context-store-snapshot/v1" as const,
      storeId: "10000000-0000-4000-8000-000000000001",
      revision: 1,
      snapshotHash: "a".repeat(64),
      createdAt: "2026-07-22T00:00:00.000Z",
      directories: ["legacy folder"],
      files: [
        {
          id: "legacy folder/legacy file.md",
          content: "legacy",
          metadata: { trigger: "model_decision" as const, priority: "normal" as const },
        },
      ],
    };
    expect(ContextStoreRevisionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      ContextStoreChangeSetSchema.safeParse({
        schemaVersion: "pragma.context-store-change-set/v2",
        operation: "revise",
        storeId: snapshot.storeId,
        baseRevision: 1,
        baseSnapshotHash: snapshot.snapshotHash,
        summary: "Create a non-portable file.",
        operations: [
          {
            operation: "upsert",
            id: "items/non portable.md",
            content: "new",
            metadata: { trigger: "model_decision", priority: "normal" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate snapshot paths", () => {
    const file = {
      id: "items/example.md",
      content: "example",
      metadata: { trigger: "model_decision" as const, priority: "normal" as const },
    };
    expect(
      ContextStoreRevisionSnapshotSchema.safeParse({
        schemaVersion: "pragma.context-store-snapshot/v1",
        storeId: "10000000-0000-4000-8000-000000000001",
        revision: 1,
        snapshotHash: "a".repeat(64),
        createdAt: "2026-07-22T00:00:00.000Z",
        directories: [],
        files: [file, file],
      }).success,
    ).toBe(false);
  });
});

describe("Flow draft contracts", () => {
  it("inherits canonical Flow defaults while allowing an incomplete graph", () => {
    const draft = PragmaAgentFlowDraftSchema.parse({
      draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
      baseProjectRevision: 0,
      draftRevision: 0,
      resource: {
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Flow",
        metadata: {
          id: "t9ne4d8njvvxv2ea",
          name: "Review flow",
          description: "Review a result.",
          tags: [],
        },
        spec: { graph: { steps: {}, transitions: {} } },
      },
      diagnostics: [],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    expect(draft.resource.spec.limits).toEqual({ maxNodeVisits: 1_000 });
    expect(draft.resource.spec.graph.loops).toEqual({});
    expect(draft.resource.spec.graph.start).toBeUndefined();
  });

  it("normalizes graph IDs at the operation boundary", () => {
    expect(
      PragmaAgentFlowDraftOperationSchema.parse({
        type: "set_start",
        stepId: "  review  ",
      }),
    ).toEqual({ type: "set_start", stepId: "review" });
    expect(
      PragmaAgentFlowDraftOperationSchema.safeParse({ type: "remove_loop", loopId: "   " }).success,
    ).toBe(false);
    expect(PragmaAgentFlowDraftOperationSchema.safeParse({ type: "set_run_dry" }).success).toBe(
      false,
    );
  });
});

describe("Evaluation draft contracts", () => {
  it("allows an empty incremental draft while canonical Evaluation resources require cases", () => {
    const draft = PragmaAgentEvaluationDraftSchema.parse({
      draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
      baseProjectRevision: 0,
      draftRevision: 0,
      resource: {
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Evaluation",
        metadata: {
          id: "7h8j9k0m1n2p3q4r",
          name: "Review Run Dry",
          description: "Tests the review Flow.",
          tags: [],
        },
        spec: {
          target: { ref: "flow:8h9j0k1m2n3p4q5r" },
          method: { type: "flow-run-dry", cases: [] },
        },
      },
      diagnostics: [],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    expect(draft.resource.spec.method.cases).toEqual([]);
  });

  it("accepts typed case upserts and rejects unknown operations", () => {
    expect(
      PragmaAgentEvaluationDraftOperationSchema.parse({
        type: "upsert_case",
        case: {
          id: "approved",
          name: "Approved",
          input: {},
          mocks: {},
          expect: { status: "succeeded", path: [], output: {} },
        },
      }),
    ).toMatchObject({ type: "upsert_case", case: { id: "approved" } });
    expect(
      PragmaAgentEvaluationDraftOperationSchema.safeParse({
        type: "replace_suite",
        cases: [],
      }).success,
    ).toBe(false);
  });
});
