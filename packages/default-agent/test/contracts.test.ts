import { describe, expect, it } from "vitest";

import {
  DefaultAgentEvaluationDraftOperationSchema,
  DefaultAgentEvaluationDraftSchema,
  DefaultAgentFlowDraftOperationSchema,
  DefaultAgentFlowDraftSchema,
} from "../src/contracts.ts";

describe("Flow draft contracts", () => {
  it("inherits canonical Flow defaults while allowing an incomplete graph", () => {
    const draft = DefaultAgentFlowDraftSchema.parse({
      draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
      baseProjectRevision: 0,
      draftRevision: 0,
      resource: {
        apiVersion: "pragma/v3",
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
      DefaultAgentFlowDraftOperationSchema.parse({
        type: "set_start",
        stepId: "  review  ",
      }),
    ).toEqual({ type: "set_start", stepId: "review" });
    expect(
      DefaultAgentFlowDraftOperationSchema.safeParse({ type: "remove_loop", loopId: "   " })
        .success,
    ).toBe(false);
    expect(DefaultAgentFlowDraftOperationSchema.safeParse({ type: "set_run_dry" }).success).toBe(
      false,
    );
  });
});

describe("Evaluation draft contracts", () => {
  it("allows an empty incremental draft while canonical Evaluation resources require cases", () => {
    const draft = DefaultAgentEvaluationDraftSchema.parse({
      draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
      baseProjectRevision: 0,
      draftRevision: 0,
      resource: {
        apiVersion: "pragma/v3",
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
      DefaultAgentEvaluationDraftOperationSchema.parse({
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
      DefaultAgentEvaluationDraftOperationSchema.safeParse({
        type: "replace_suite",
        cases: [],
      }).success,
    ).toBe(false);
  });
});
