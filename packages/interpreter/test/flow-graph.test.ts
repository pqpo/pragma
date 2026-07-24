import { describe, expect, it } from "vitest";

import {
  analyzePragmaFlowGraph,
  PragmaFlowResourceSchema,
  type PragmaFlowResource,
} from "../src/ast/index.ts";

function flow(graph: PragmaFlowResource["spec"]["graph"]): PragmaFlowResource {
  return {
    apiVersion: "pragma/v2",
    kind: "Flow",
    metadata: {
      id: "review_flow",
      version: "1.0.0",
      name: "Review flow",
      description: "Review a result.",
      tags: [],
    },
    spec: { limits: { maxNodeVisits: 100 }, graph },
  };
}

const humanStep = {
  version: "1.0.0",
  human: {
    selectionMode: "single" as const,
    prompt: { segments: [{ text: "Continue?" }] },
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
};

describe("analyzePragmaFlowGraph", () => {
  it("accepts one-question Human input definitions and rejects duplicate stable values", () => {
    expect(
      PragmaFlowResourceSchema.safeParse(
        flow({
          start: "review",
          steps: { review: humanStep },
          transitions: { review: { end: true } },
          loops: {},
        }),
      ).success,
    ).toBe(true);
    const duplicate = structuredClone(humanStep);
    duplicate.human.options[1]!.value = "yes";
    expect(
      PragmaFlowResourceSchema.safeParse(
        flow({
          start: "review",
          steps: { review: duplicate },
          transitions: { review: { end: true } },
          loops: {},
        }),
      ).success,
    ).toBe(false);
  });

  it("includes ordered array-route branch destinations in graph analysis", () => {
    const analysis = analyzePragmaFlowGraph(
      flow({
        start: "review",
        steps: { review: humanStep, yes: humanStep, no: humanStep },
        transitions: {
          review: {
            route: "selection",
            branches: [
              {
                id: "yes_selected",
                operator: "contains_any",
                values: ["yes"],
                destination: { goto: "yes" },
              },
            ],
            fallback: { goto: "no" },
          },
          yes: { end: true },
          no: { end: true },
        },
        loops: {},
      }),
    );
    expect(analysis.issues).toEqual([]);
  });

  it("reports an empty route at the DSL transition path", () => {
    const analysis = analyzePragmaFlowGraph(
      flow({
        start: "review",
        steps: { review: humanStep },
        transitions: { review: { route: "decision", cases: {} } },
        loops: {},
      }),
    );
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({
        code: "flow.graph.route_empty",
        path: ["spec", "graph", "transitions", "review"],
      }),
    );
  });

  it("translates repeat and onLimit edges into one bounded loop region", () => {
    const analysis = analyzePragmaFlowGraph(
      flow({
        start: "review",
        steps: { review: humanStep, revise: humanStep, exit: humanStep },
        transitions: {
          review: { goto: "revise" },
          revise: { repeat: { loop: "revision", goto: "review" } },
          exit: { end: true },
        },
        loops: {
          revision: { entry: "review", maxIterations: 2, onLimit: { goto: "exit" } },
        },
      }),
    );
    expect(analysis.issues).toEqual([]);
    expect([...analysis.loopMembers.get("revision")!]).toEqual(
      expect.arrayContaining(["review", "revise"]),
    );
  });

  it("prefixes shared graph issues and maps them back to the source step", () => {
    const analysis = analyzePragmaFlowGraph(
      flow({
        start: "review",
        steps: { review: humanStep },
        transitions: { review: { goto: "missing" } },
        loops: {},
      }),
    );
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({
        code: "flow.graph.transition.target_unknown",
        path: ["spec", "graph", "steps", "review"],
        stepId: "review",
      }),
    );
  });
});
