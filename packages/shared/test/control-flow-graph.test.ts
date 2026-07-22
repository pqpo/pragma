import { describe, expect, it } from "vitest";

import { analyzeControlFlowGraph, type ControlFlowGraph } from "../src/control-flow-graph.ts";

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
