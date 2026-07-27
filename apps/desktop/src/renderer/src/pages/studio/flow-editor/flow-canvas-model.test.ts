import { describe, expect, it } from "vitest";

import { createEmptyFlow } from "./flow-model.ts";
import {
  buildCanvasEdges,
  buildCanvasNodes,
  canvasPositions,
  createRouteTransition,
  defaultStep,
  inspectorNodeId,
  nextAvailableNodePosition,
  normalizeConnectionDestination,
  rebuildCanvasNodesPreservingSelection,
  removeEdgeFromFlow,
  resourceTargets,
  routeFieldOptions,
} from "./flow-canvas-model.ts";
import { END_NODE_ID, FAIL_NODE_ID, START_NODE_ID } from "./flow-canvas-types.ts";
import { flowVariableOptions } from "./flow-prompt-editor.tsx";
import { flowFixture } from "./flow-editor-test-fixtures.ts";

describe("flow-canvas-model", () => {
  it("offers the built-in Expert as a Flow target outside project resources", () => {
    expect(
      resourceTargets([], "0000000000000001", [{ ref: "expert:0000000000pragma", name: "Pragma" }]),
    ).toEqual([{ kind: "expert", ref: "expert:0000000000pragma", label: "Pragma" }]);
  });

  it("leaves a new semantic step unselected when no matching resource exists", () => {
    expect(defaultStep("expert", [], { optionLabels: ["One", "Two"] })).toMatchObject({
      expert: { ref: "" },
    });
    expect(defaultStep("team", [], { optionLabels: ["One", "Two"] })).toMatchObject({
      team: { ref: "" },
    });
    expect(defaultStep("flow", [], { optionLabels: ["One", "Two"] })).toMatchObject({
      flow: { ref: "" },
    });
  });

  it("renders a new draft as draggable Start and End terminals without Fail", () => {
    const positions = {
      [START_NODE_ID]: { x: 12, y: 34 },
      [END_NODE_ID]: { x: 560, y: 78 },
      [FAIL_NODE_ID]: { x: 560, y: 188 },
    };

    const nodes = buildCanvasNodes(createEmptyFlow(), positions);

    for (const terminalId of [START_NODE_ID, END_NODE_ID] as const) {
      const terminal = nodes.find((node) => node.id === terminalId);
      expect(terminal?.draggable).toBe(true);
      expect(terminal?.deletable).toBe(false);
      expect(terminal?.position).toEqual(positions[terminalId]);
    }
    expect(nodes.find((node) => node.id === FAIL_NODE_ID)).toBeUndefined();
    expect(buildCanvasEdges(createEmptyFlow())).toEqual([]);

    const defaultNodes = buildCanvasNodes(createEmptyFlow(), {});
    expect(defaultNodes.find((node) => node.id === START_NODE_ID)?.position.y).toBe(
      defaultNodes.find((node) => node.id === END_NODE_ID)?.position.y,
    );
  });

  it("leaves generous default spacing around the start and terminal nodes", () => {
    const nodes = buildCanvasNodes(flowFixture(), {});
    const step = nodes.find((node) => node.id === "review")!;
    const start = nodes.find((node) => node.id === START_NODE_ID)!;
    const end = nodes.find((node) => node.id === END_NODE_ID)!;

    expect(step.position.x - (start.position.x + 112)).toBeGreaterThanOrEqual(180);
    expect(end.position.x - (step.position.x + 238)).toBeGreaterThanOrEqual(180);
  });

  it("includes terminal nodes when collecting positions for layout persistence", () => {
    const nodes = buildCanvasNodes(flowFixture(), {});

    expect(Object.keys(canvasPositions(nodes))).toEqual(
      expect.arrayContaining(["review", START_NODE_ID, END_NODE_ID]),
    );
    expect(Object.keys(canvasPositions(nodes))).not.toContain(FAIL_NODE_ID);
  });

  it("keeps terminal nodes selectable so End can expose result mapping", () => {
    const nodes = buildCanvasNodes(createEmptyFlow(), {});
    const start = nodes.find((node) => node.id === START_NODE_ID);
    const end = nodes.find((node) => node.id === END_NODE_ID);

    expect(inspectorNodeId(start)).toBe(START_NODE_ID);
    expect(inspectorNodeId(end)).toBe(END_NODE_ID);
    expect(inspectorNodeId(undefined)).toBeNull();
  });

  it("keeps End selected when result-source edits rebuild the canvas nodes", () => {
    const flow = createEmptyFlow();
    flow.spec.output = {
      schema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
        additionalProperties: false,
      },
    };

    const terminalResultNodes = buildCanvasNodes(flow, {}, new Set(), END_NODE_ID);
    flow.spec.output.value = { result: "$node.output.result" };
    const mappedResultNodes = rebuildCanvasNodesPreservingSelection(flow, terminalResultNodes);

    expect(terminalResultNodes.find((node) => node.id === END_NODE_ID)?.selected).toBe(true);
    expect(mappedResultNodes.find((node) => node.id === END_NODE_ID)?.selected).toBe(true);
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
    };

    expect(flow.spec.graph.start).toBe("");
    expect(buildCanvasEdges(flow).some((edge) => edge.id === "start-edge")).toBe(false);
    expect(buildCanvasEdges(flow).some((edge) => edge.source === "expert_1")).toBe(false);
  });

  it("allows the Start connection to be deleted without selecting another start node", () => {
    const flow = flowFixture();
    const edge = buildCanvasEdges(flow).find((candidate) => candidate.id === "start-edge")!;

    expect(edge.deletable).toBe(true);
    removeEdgeFromFlow(flow, edge);

    expect(flow.spec.graph.start).toBe("");
    expect(buildCanvasEdges(flow).some((candidate) => candidate.id === "start-edge")).toBe(false);
  });

  it("removes a transition instead of replacing it with an End edge", () => {
    const flow = flowFixture();
    const edge = buildCanvasEdges(flow).find((candidate) => candidate.id === "review:default")!;

    removeEdgeFromFlow(flow, edge);

    expect(flow.spec.graph.transitions.review).toBeUndefined();
    expect(buildCanvasEdges(flow).some((candidate) => candidate.source === "review")).toBe(false);
  });

  it("shows Fail only while a transition or loop limit references it", () => {
    const direct = flowFixture();
    direct.spec.graph.transitions.review = { fail: "Rejected" };
    expect(buildCanvasNodes(direct, {}).some((node) => node.id === FAIL_NODE_ID)).toBe(true);

    const routed = flowFixture();
    routed.spec.graph.transitions.review = {
      route: "decision",
      cases: { rejected: { fail: "Rejected" } },
      fallback: { end: true },
    };
    expect(buildCanvasNodes(routed, {}).some((node) => node.id === FAIL_NODE_ID)).toBe(true);

    const limited = flowFixture();
    limited.spec.graph.loops.review_loop = {
      entry: "review",
      maxIterations: 3,
      onLimit: { fail: "Review timed out" },
    };
    expect(buildCanvasNodes(limited, {}).some((node) => node.id === FAIL_NODE_ID)).toBe(true);

    expect(buildCanvasNodes(flowFixture(), {}).some((node) => node.id === FAIL_NODE_ID)).toBe(
      false,
    );
  });

  it("projects route transitions into standalone logic nodes and branch edges", () => {
    const flow = flowFixture();
    flow.spec.graph.steps.review!.output = {
      schema: {
        type: "object",
        properties: { has_issue: { type: "boolean" } },
        required: ["has_issue"],
        additionalProperties: false,
      },
    };
    flow.spec.graph.transitions.review = {
      route: "has_issue",
      cases: { true: { goto: "fix" }, false: { end: true } },
    };
    flow.spec.graph.steps.fix = {
      expert: { ref: "expert:1cdxef9n20xk5n1f" },
    };
    flow.spec.graph.transitions.fix = { end: true };

    const nodes = buildCanvasNodes(flow, {});
    const logic = nodes.find((node) => node.type === "logic");
    const review = nodes.find((node) => node.id === "review" && node.type === "step");
    const edges = buildCanvasEdges(flow);

    expect(logic).toMatchObject({
      type: "logic",
      data: {
        sourceId: "review",
        label: "has_issue",
        fieldLabel: "review.result.has_issue",
        outputs: [
          { id: "case:true", label: "true" },
          { id: "case:false", label: "false" },
        ],
      },
    });
    expect(review?.data.outputs).toEqual([{ id: "default", label: "result" }]);
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "review:logic-input",
          source: "review",
          target: logic?.id,
          deletable: true,
        }),
        expect.objectContaining({
          source: logic?.id,
          sourceHandle: "case:true",
          target: "fix",
        }),
        expect.objectContaining({
          source: logic?.id,
          sourceHandle: "case:false",
          target: END_NODE_ID,
        }),
      ]),
    );
  });

  it("deletes the condition and all branches when its input connection is deleted", () => {
    const flow = flowFixture();
    flow.spec.graph.transitions.review = {
      route: "decision",
      cases: { approve: { goto: "fix" }, reject: { end: true } },
      fallback: { fail: "Unknown decision" },
    };
    flow.spec.graph.steps.fix = {
      expert: { ref: "expert:1cdxef9n20xk5n1f" },
    };
    const edge = buildCanvasEdges(flow).find((candidate) => candidate.id === "review:logic-input")!;

    removeEdgeFromFlow(flow, edge);

    expect(flow.spec.graph.transitions.review).toBeUndefined();
    expect(buildCanvasNodes(flow, {}).some((node) => node.type === "logic")).toBe(false);
    expect(buildCanvasEdges(flow).some((candidate) => candidate.source === "review")).toBe(false);
  });

  it("deletes a branch connection while keeping its branch port available", () => {
    const flow = flowFixture();
    flow.spec.graph.transitions.review = {
      route: "decision",
      cases: { approve: { goto: "finish" } },
      fallback: { end: true },
    };
    const edge = buildCanvasEdges(flow).find(
      (candidate) => candidate.sourceHandle === "case:approve",
    )!;

    removeEdgeFromFlow(flow, edge);

    expect(flow.spec.graph.transitions.review).toMatchObject({
      cases: { approve: { goto: "" } },
    });
    expect(
      buildCanvasNodes(flow, {})
        .find((node) => node.type === "logic")
        ?.data.outputs.some((output) => output.id === "case:approve"),
    ).toBe(true);
    expect(
      buildCanvasEdges(flow).some((candidate) => candidate.sourceHandle === "case:approve"),
    ).toBe(false);
  });

  it("infers scalar route fields and creates boolean true/false branches without result prefix", () => {
    const flow = flowFixture();
    flow.spec.graph.steps.review!.output = {
      schema: {
        type: "object",
        properties: {
          has_issue: { type: "boolean" },
          score: { type: "number" },
          details: {
            type: "object",
            properties: { note: { type: "string" } },
            required: ["note"],
            additionalProperties: false,
          },
        },
        required: ["has_issue"],
        additionalProperties: false,
      },
    };

    const fields = routeFieldOptions(flow, "review");
    const route = createRouteTransition(fields.find((field) => field.name === "has_issue"));

    expect(fields).toEqual([
      { name: "has_issue", type: "boolean" },
      { name: "score", type: "number" },
    ]);
    expect(route).toEqual({
      route: "has_issue",
      cases: {
        true: { goto: "" },
        false: { goto: "" },
      },
    });
    expect(route.route).not.toContain("result.");
    flow.spec.graph.transitions.review = route;
    expect(
      buildCanvasEdges(flow).filter((edge) => edge.sourceHandle?.startsWith("case:")),
    ).toHaveLength(0);
  });

  it("infers Human selection output and creates ordered array branches from stable option values", () => {
    const flow = flowFixture();
    flow.spec.graph.steps.review = {
      human: {
        selectionMode: "multiple",
        prompt: { segments: [{ text: "Choose release actions." }] },
        options: [
          { value: "ship", label: "Ship" },
          { value: "notify", label: "Notify users" },
        ],
      },
    };
    flow.spec.graph.steps.finish = {
      expert: { ref: "expert:ksqvz9mb6gy5y2kn" },
      prompt: { segments: [{ text: "Finish." }] },
    };
    flow.spec.graph.transitions.review = { goto: "finish" };
    flow.spec.graph.transitions.finish = { end: true };

    const fields = routeFieldOptions(flow, "review");
    expect(fields).toEqual([
      { name: "selection", type: "string-array", values: ["ship", "notify"] },
    ]);
    expect(flowVariableOptions(flow, "finish")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "review.result.selection",
          variable: { source: "node-output", nodeId: "review", path: ["selection"] },
        }),
      ]),
    );

    const route = createRouteTransition(fields[0]);
    expect(route).toMatchObject({
      route: "selection",
      branches: [
        { id: "branch_1", operator: "contains_any", values: ["ship"] },
        { id: "branch_2", operator: "contains_any", values: ["notify"] },
      ],
      fallback: { goto: "" },
    });
    flow.spec.graph.transitions.review = route;
    expect(
      buildCanvasNodes(flow, {})
        .find((node) => node.type === "logic")
        ?.data.outputs.map((output) => output.id),
    ).toEqual(["branch:branch_1", "branch:branch_2", "fallback"]);
  });

  it("turns a cycle-producing canvas connection into a bounded repeat edge", () => {
    const flow = flowFixture();
    flow.spec.graph.steps.finish = {
      expert: { ref: "expert:ksqvz9mb6gy5y2kn" },
    };
    flow.spec.graph.transitions.review = { goto: "finish" };
    flow.spec.graph.transitions.finish = { end: true };

    const destination = normalizeConnectionDestination(flow, "finish", { goto: "review" });

    expect(destination).toEqual({
      repeat: { loop: "loop_finish_review", goto: "review" },
    });
    expect(flow.spec.graph.loops.loop_finish_review).toEqual({
      entry: "review",
      maxIterations: 3,
      onLimit: { fail: "Loop loop_finish_review reached its limit." },
    });
  });

  it("preserves the selected step across semantic canvas rebuilds", () => {
    const flow = flowFixture();
    const before = buildCanvasNodes(flow, {}, new Set(), "review");
    flow.spec.graph.steps.review!.prompt = { segments: [{ text: "Updated" }] };
    const after = buildCanvasNodes(flow, canvasPositions(before), new Set(), "review");

    expect(after.find((node) => node.id === "review")?.selected).toBe(true);
  });
});
