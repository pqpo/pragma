import { describe, expect, it } from "vitest";

import type { PragmaFlowResource } from "@pragma/interpreter/ast";

import {
  createEmptyFlow,
  deleteFlowStep,
  renameFlowStep,
  validateFlowDraft,
} from "./flow-model.ts";

describe("Flow editor model", () => {
  it("starts new Flows as empty editor drafts with one actionable issue", () => {
    const flow = createEmptyFlow("triage_flow");

    expect(flow.spec.graph).toEqual({ start: "", steps: {}, loops: {}, transitions: {} });
    expect(validateFlowDraft(flow)).toEqual([
      { path: ["spec", "graph", "steps"], message: "Add at least one node." },
    ]);
  });

  it("keeps the complete route and bounded-repeat semantics editable", () => {
    const flow = flowFixture();
    flow.spec.graph.loops = {
      review_loop: { entry: "review", maxIterations: 3, onLimit: { fail: "Review timed out" } },
    };
    flow.spec.graph.transitions["review"] = {
      route: "decision",
      cases: {
        approved: { goto: "finish" },
        rejected: { fail: "Rejected" },
        retry: { repeat: { loop: "review_loop", goto: "review" } },
      },
      fallback: { end: true },
    };

    expect(validateFlowDraft(flow)).toEqual([]);
  });

  it("renames every graph reference without touching resource semantics", () => {
    const flow = flowFixture();
    flow.spec.graph.loops = { review_loop: { entry: "review", maxIterations: 3 } };
    flow.spec.graph.transitions["finish"] = {
      repeat: { loop: "review_loop", goto: "review" },
    };

    const renamed = renameFlowStep(flow, "review", "approval_gate");

    expect(renamed.spec.graph.start).toBe("approval_gate");
    expect(renamed.spec.graph.steps["approval_gate"]).toEqual(flow.spec.graph.steps["review"]);
    expect(renamed.spec.graph.steps["review"]).toBeUndefined();
    expect(renamed.spec.graph.transitions["finish"]).toEqual({
      repeat: { loop: "review_loop", goto: "approval_gate" },
    });
    expect(renamed.spec.graph.loops["review_loop"]?.entry).toBe("approval_gate");
  });

  it("removes dangling destinations when a step is deleted", () => {
    const flow = flowFixture();
    const removed = deleteFlowStep(flow, "finish");

    expect(removed.spec.graph.steps["finish"]).toBeUndefined();
    expect(removed.spec.graph.transitions["review"]).toEqual({ end: true });
    expect(validateFlowDraft(removed)).toEqual([]);
  });

  it("replaces deleted loop-limit destinations while preserving referenced loops", () => {
    const flow = flowFixture();
    flow.spec.graph.loops = {
      review_loop: { entry: "review", maxIterations: 3, onLimit: { goto: "finish" } },
    };
    flow.spec.graph.transitions["review"] = {
      repeat: { loop: "review_loop", goto: "review" },
    };

    const removed = deleteFlowStep(flow, "finish");

    expect(removed.spec.graph.loops["review_loop"]).toEqual({
      entry: "review",
      maxIterations: 3,
      onLimit: { end: true },
    });
    expect(validateFlowDraft(removed)).toEqual([]);
  });

  it("removes loop definitions that become unreferenced after deleting a step", () => {
    const flow = flowFixture();
    flow.spec.graph.loops = {
      review_loop: { entry: "review", maxIterations: 3 },
    };
    flow.spec.graph.transitions["finish"] = {
      repeat: { loop: "review_loop", goto: "review" },
    };

    const removed = deleteFlowStep(flow, "finish");

    expect(removed.spec.graph.loops["review_loop"]).toBeUndefined();
    expect(validateFlowDraft(removed)).toEqual([]);
  });

  it("returns to the empty draft state after deleting the last step", () => {
    const flow = flowFixture();
    const withoutFinish = deleteFlowStep(flow, "finish");
    const empty = deleteFlowStep(withoutFinish, "review");

    expect(empty.spec.graph).toEqual({ start: "", steps: {}, loops: {}, transitions: {} });
    expect(validateFlowDraft(empty)).toEqual([
      { path: ["spec", "graph", "steps"], message: "Add at least one node." },
    ]);
  });

  it("blocks Action steps that Desktop cannot execute", () => {
    const flow = flowFixture();
    flow.spec.graph.steps.review = {
      action: { ref: "action:review@1.0.0" },
      version: "1.0.0",
    };

    expect(validateFlowDraft(flow)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "review",
          message: "Action steps are not executable in the current Desktop environment.",
        }),
      ]),
    );
  });
});

function flowFixture(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v2",
    kind: "Flow",
    metadata: {
      id: "review",
      version: "1.0.0",
      name: "Review",
      description: "Review a change",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "review",
        steps: {
          review: {
            human: { kind: "approval", prompt: "Approve?" },
            version: "2.0.0",
          },
          finish: {
            human: { kind: "approval", prompt: "Finish?" },
            version: "1.0.0",
          },
        },
        loops: {},
        transitions: { review: { goto: "finish" }, finish: { end: true } },
      },
    },
  };
}
