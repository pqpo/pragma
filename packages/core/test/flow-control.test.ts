import { describe, expect, it } from "vitest";

import {
  resolveFlowRepeat,
  selectFlowTransition,
  type FlowLoopDefinition,
  type FlowRepeatTarget,
  type FlowTransition,
} from "../src/index.ts";

describe("Flow control semantics", () => {
  it("selects route cases and fallbacks", () => {
    const transition: FlowTransition = {
      type: "route",
      field: "decision",
      cases: new Map([["approve", { id: "publish" }]]),
      fallback: { id: "review" },
    };

    expect(selectFlowTransition(transition, { decision: "approve" })).toEqual({
      kind: "case",
      caseKey: "approve",
      destination: { id: "publish" },
    });
    expect(selectFlowTransition(transition, { decision: "unknown" })).toEqual({
      kind: "fallback",
      destination: { id: "review" },
    });
  });

  it("selects array-route branches in declaration order and exposes the branch id", () => {
    const transition: FlowTransition = {
      type: "array-route",
      field: "labels",
      branches: [
        {
          id: "all",
          operator: "contains_all",
          values: ["a", "b"],
          destination: { id: "all" },
        },
        {
          id: "any",
          operator: "contains_any",
          values: ["c"],
          destination: { id: "any" },
        },
        {
          id: "none",
          operator: "contains_none",
          values: ["d"],
          destination: { id: "none" },
        },
      ],
      fallback: { id: "fallback" },
    };

    expect(selectFlowTransition(transition, { labels: ["a", "b"] })?.kind).toBe("branch");
    expect(selectFlowTransition(transition, { labels: ["c"] })).toMatchObject({
      kind: "branch",
      branchId: "any",
    });
    expect(selectFlowTransition(transition, { labels: ["x"] })).toMatchObject({
      kind: "branch",
      branchId: "none",
    });
    expect(selectFlowTransition(transition, { labels: ["d"] })).toEqual({
      kind: "fallback",
      destination: { id: "fallback" },
    });
  });

  it("resolves repeat and limit outcomes from the same loop rule used by execution", () => {
    const destination: FlowRepeatTarget = {
      type: "repeat",
      loopId: "review",
      target: { id: "draft" },
    };
    const loop: FlowLoopDefinition = {
      id: "review",
      entryStepId: "draft",
      stepIds: new Set(["draft", "review"]),
      maxIterations: 2,
      onLimit: { type: "fail", reason: "Review limit reached" },
    };

    expect(resolveFlowRepeat(destination, loop, 1)).toEqual({
      kind: "repeat",
      iteration: 2,
      target: { id: "draft" },
    });
    expect(resolveFlowRepeat(destination, loop, 2)).toEqual({
      kind: "limit",
      iteration: 2,
      target: { type: "fail", reason: "Review limit reached" },
    });
  });
});
