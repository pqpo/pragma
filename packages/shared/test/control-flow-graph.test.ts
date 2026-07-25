import { describe, expect, it } from "vitest";

import {
  analyzeControlFlowGraph,
  analyzeControlFlowNodeAvailability,
  type ControlFlowGraph,
} from "../src/control-flow-graph.ts";

function analyze(overrides: Partial<ControlFlowGraph> = {}) {
  return analyzeControlFlowGraph({
    nodes: new Set(["one", "two"]),
    start: "one",
    transitionSources: new Set(["one", "two"]),
    edges: [{ source: "one", target: "two", kind: "ordinary" }],
    loops: [],
    ...overrides,
  });
}

describe("analyzeControlFlowGraph", () => {
  it("accepts a reachable terminating DAG", () => {
    expect(analyze().issues).toEqual([]);
  });

  it("reports missing transitions and unreachable steps", () => {
    const result = analyze({
      nodes: new Set(["one", "two", "orphan"]),
      transitionSources: new Set(["one", "two"]),
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["transition.missing", "step.unreachable"]),
    );
  });

  it("accepts an explicit bounded repeat and returns its members", () => {
    const result = analyze({
      edges: [
        { source: "one", target: "two", kind: "ordinary" },
        { source: "two", target: "one", kind: "repeat", loopId: "retry" },
      ],
      loops: [{ id: "retry", entry: "one" }],
    });
    expect(result.issues).toEqual([]);
    expect([...result.loopMembers.get("retry")!]).toEqual(expect.arrayContaining(["one", "two"]));
  });

  it("rejects an unbounded ordinary cycle", () => {
    const result = analyze({
      edges: [
        { source: "one", target: "two", kind: "ordinary" },
        { source: "two", target: "one", kind: "ordinary" },
      ],
    });
    expect(result.issues.map((issue) => issue.code)).toContain("cycle.ordinary");
  });

  it("does not misreport loops in an ambiguous cyclic region as non-cyclic", () => {
    const result = analyze({
      edges: [
        { source: "one", target: "two", kind: "ordinary" },
        { source: "two", target: "one", kind: "repeat", loopId: "first" },
      ],
      loops: [
        { id: "first", entry: "one" },
        { id: "second", entry: "two" },
      ],
    });
    expect(result.issues.map((issue) => issue.code)).toContain("loop.region_ambiguous");
    expect(result.issues.map((issue) => issue.code)).not.toContain("loop.not_cyclic");
  });
});

describe("analyzeControlFlowNodeAvailability", () => {
  it("marks branch-only predecessors optional and dominators required", () => {
    const availability = analyzeControlFlowNodeAvailability(
      {
        nodes: new Set(["start", "left", "right", "join"]),
        start: "start",
        edges: [
          { source: "start", target: "left", kind: "ordinary" },
          { source: "start", target: "right", kind: "ordinary" },
          { source: "left", target: "join", kind: "ordinary" },
          { source: "right", target: "join", kind: "ordinary" },
        ],
      },
      "join",
    );
    expect([...availability.upstream]).toEqual(expect.arrayContaining(["start", "left", "right"]));
    expect([...availability.required]).toEqual(["start"]);
  });

  it("includes loop-back predecessors as optional upstream nodes for the loop entry", () => {
    const availability = analyzeControlFlowNodeAvailability(
      {
        nodes: new Set(["start", "draft", "review", "decide", "done"]),
        start: "start",
        edges: [
          { source: "start", target: "draft", kind: "ordinary" },
          { source: "draft", target: "review", kind: "ordinary" },
          { source: "review", target: "decide", kind: "ordinary" },
          { source: "decide", target: "draft", kind: "repeat", loopId: "revise" },
          { source: "decide", target: "done", kind: "ordinary" },
        ],
      },
      "draft",
    );

    expect([...availability.upstream]).toEqual(
      expect.arrayContaining(["start", "review", "decide"]),
    );
    expect([...availability.required]).toEqual(["start"]);
  });
});
