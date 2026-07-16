import { describe, expect, it } from "vitest";

import { createEmptyFlow } from "./flow-model.ts";
import {
  buildCanvasNodes,
  buildCanvasEdges,
  canvasPositions,
  END_NODE_ID,
  FAIL_NODE_ID,
  nextAvailableNodePosition,
  removeEdgeFromFlow,
  START_NODE_ID,
} from "./FlowEditor.tsx";

describe("Flow editor canvas", () => {
  it("keeps terminal nodes draggable and restores their saved positions", () => {
    const positions = {
      start: { x: 200, y: 160 },
      [START_NODE_ID]: { x: 12, y: 34 },
      [END_NODE_ID]: { x: 560, y: 78 },
      [FAIL_NODE_ID]: { x: 560, y: 188 },
    };

    const nodes = buildCanvasNodes(createEmptyFlow(), positions);

    for (const terminalId of [START_NODE_ID, END_NODE_ID, FAIL_NODE_ID] as const) {
      const terminal = nodes.find((node) => node.id === terminalId);
      expect(terminal?.draggable).toBe(true);
      expect(terminal?.deletable).toBe(false);
      expect(terminal?.position).toEqual(positions[terminalId]);
    }
  });

  it("leaves generous default spacing around the start and terminal nodes", () => {
    const nodes = buildCanvasNodes(createEmptyFlow(), {});
    const step = nodes.find((node) => node.id === "start")!;
    const start = nodes.find((node) => node.id === START_NODE_ID)!;
    const end = nodes.find((node) => node.id === END_NODE_ID)!;
    const fail = nodes.find((node) => node.id === FAIL_NODE_ID)!;

    expect(step.position.x - (start.position.x + 112)).toBeGreaterThanOrEqual(180);
    expect(end.position.x - (step.position.x + 238)).toBeGreaterThanOrEqual(180);
    expect(fail.position.x - (step.position.x + 238)).toBeGreaterThanOrEqual(180);
  });

  it("includes terminal nodes when collecting positions for layout persistence", () => {
    const nodes = buildCanvasNodes(createEmptyFlow(), {});

    expect(Object.keys(canvasPositions(nodes))).toEqual(
      expect.arrayContaining(["start", START_NODE_ID, END_NODE_ID, FAIL_NODE_ID]),
    );
  });

  it("places repeatedly added nodes into distinct non-overlapping grid cells", () => {
    const positions: Record<string, { x: number; y: number }> = {};
    const preferred = { x: 180, y: 180 };

    for (let index = 0; index < 8; index += 1) {
      positions[`node_${index}`] = nextAvailableNodePosition(positions, preferred);
    }

    const added = Object.values(positions);
    expect(new Set(added.map(({ x, y }) => `${x}:${y}`))).toHaveLength(8);
    for (const [index, current] of added.entries()) {
      for (const previous of added.slice(0, index)) {
        expect(
          Math.abs(current.x - previous.x) >= 238 || Math.abs(current.y - previous.y) >= 104,
        ).toBe(true);
      }
    }
  });

  it("does not render an automatic edge for a newly added unconnected step", () => {
    const flow = createEmptyFlow();
    flow.spec.graph.steps.expert_1 = {
      expert: { ref: "reviewer" },
      version: "1.0.0",
    };

    expect(buildCanvasEdges(flow).some((edge) => edge.source === "expert_1")).toBe(false);
  });

  it("removes a transition instead of replacing it with an End edge", () => {
    const flow = createEmptyFlow();
    const edge = buildCanvasEdges(flow).find((candidate) => candidate.id === "start:default")!;

    removeEdgeFromFlow(flow, edge);

    expect(flow.spec.graph.transitions.start).toBeUndefined();
    expect(buildCanvasEdges(flow).some((candidate) => candidate.source === "start")).toBe(false);
  });
});
