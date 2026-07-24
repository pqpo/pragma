import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PragmaFlowPrompt, PragmaFlowResource, PragmaResource } from "@pragma/interpreter/ast";

import type { PragmaProjectSnapshot } from "../../../../../shared/desktop-api.ts";
import { newSchemaField, objectSchemaToFields } from "../JsonSchemaFieldsEditor.tsx";
import { createEmptyFlow } from "./flow-model.ts";
import {
  buildCanvasNodes,
  buildCanvasEdges,
  canvasPositions,
  createRouteTransition,
  END_NODE_ID,
  FAIL_NODE_ID,
  FLOW_ERROR_AUTO_DISMISS_MS,
  FlowEditor,
  flowRuntimeProfile,
  flowVariableOptions,
  inspectorNodeId,
  nextAvailableNodePosition,
  nextHumanOptionNumber,
  normalizeConnectionDestination,
  normalizePromptSegments,
  promptSegmentsFromEditorNodes,
  PromptTemplateEditor,
  removeEdgeFromFlow,
  removeHumanOption,
  routeFieldOptions,
  RuntimeBindingEditor,
  START_NODE_ID,
  validateFlowRuntimeSelections,
  validateLogicRoutes,
} from "./FlowEditor.tsx";

describe("Flow editor canvas", () => {
  it("dismisses transient editor errors after five seconds", () => {
    expect(FLOW_ERROR_AUTO_DISMISS_MS).toBe(5_000);
  });

  it("exposes palette items as drag-only controls", () => {
    const project: PragmaProjectSnapshot = {
      schemaVersion: "pragma.project-snapshot/v2",
      projectId: "test-project",
      revision: 0,
      resources: [],
      diagnostics: [],
    };
    const html = renderToStaticMarkup(
      createElement(FlowEditor, {
        project,
        error: null,
        onCancel: () => undefined,
        onSave: async () => true,
      }),
    );

    expect(html).toContain('class="flow-palette-item is-expert" draggable="true"');
    expect(html).not.toContain('<button class="flow-palette-item');
    expect(html).toContain("Drag to canvas");
    expect(html).not.toContain("press Enter");
    expect(html).not.toContain("flow-palette-item is-action");
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

  it("allows every Human option to be removed while keeping new values unique", () => {
    const initial = [
      { value: "option_1", label: "Option 1" },
      { value: "option_2", label: "Option 2" },
    ];

    const oneOption = removeHumanOption(initial, 0);
    const noOptions = removeHumanOption(oneOption, 0);

    expect(oneOption).toEqual([{ value: "option_2", label: "Option 2" }]);
    expect(noOptions).toEqual([]);
    expect(nextHumanOptionNumber(oneOption)).toBe(1);
    expect(nextHumanOptionNumber(initial)).toBe(3);
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
      expert: { ref: "expert:fix@1.0.0" },
      version: "1.0.0",
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
      expert: { ref: "expert:fix@1.0.0" },
      version: "1.0.0",
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
      version: "1.0.0",
    };
    flow.spec.graph.steps.finish = {
      expert: { ref: "expert:finish@1.0.0" },
      prompt: { segments: [{ text: "Finish." }] },
      version: "1.0.0",
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

  it("requires complete type-aware branches while preserving unresolved legacy route fields", () => {
    const flow = flowFixture();
    flow.spec.graph.steps.review!.output = {
      schema: {
        type: "object",
        properties: { has_issue: { type: "boolean" }, outcome: { type: "string" } },
        required: ["has_issue", "outcome"],
        additionalProperties: false,
      },
    };
    flow.spec.graph.transitions.review = {
      route: "has_issue",
      cases: { true: { end: true } },
    };

    expect(validateLogicRoutes(flow)).toEqual([
      expect.objectContaining({
        stepId: "review",
        message: expect.stringContaining("true and false"),
      }),
    ]);

    flow.spec.graph.transitions.review = {
      route: "outcome",
      cases: { success: { end: true } },
    };
    expect(validateLogicRoutes(flow)).toEqual([
      expect.objectContaining({ message: expect.stringContaining("otherwise") }),
    ]);

    flow.spec.graph.transitions.review = {
      route: "legacy_field",
      cases: { success: { end: true } },
    };
    expect(validateLogicRoutes(flow)).toEqual([]);
  });

  it("turns a cycle-producing canvas connection into a bounded repeat edge", () => {
    const flow = flowFixture();
    flow.spec.graph.steps.finish = {
      expert: { ref: "expert:finish@1.0.0" },
      version: "1.0.0",
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
    flow.spec.graph.steps.review!.version = "2.0.0";
    const after = buildCanvasNodes(flow, canvasPositions(before), new Set(), "review");

    expect(after.find((node) => node.id === "review")?.selected).toBe(true);
  });

  it("derives native and structured variables and marks branch-only output optional", () => {
    const flow = flowFixture();
    flow.spec.graph.start = "start";
    flow.spec.graph.steps = {
      start: {
        expert: { ref: "expert:start@1.0.0" },
        version: "1.0.0",
        prompt: { segments: [{ text: "Start" }] },
      },
      scored: {
        expert: { ref: "expert:scored@1.0.0" },
        version: "1.0.0",
        prompt: { segments: [{ text: "Score" }] },
        output: {
          schema: {
            type: "object",
            properties: { score: { type: "number" }, note: { type: "string" } },
            required: ["score"],
            additionalProperties: false,
          },
        },
      },
      alternate: {
        expert: { ref: "expert:alternate@1.0.0" },
        version: "1.0.0",
        prompt: { segments: [{ text: "Alternate" }] },
      },
      join: {
        expert: { ref: "expert:join@1.0.0" },
        version: "1.0.0",
        prompt: { segments: [{ text: "Join" }] },
      },
    };
    flow.spec.graph.transitions = {
      start: {
        route: "branch",
        cases: { scored: "scored", alternate: "alternate" },
      },
      scored: "join",
      alternate: "join",
      join: { end: true },
    };

    const options = flowVariableOptions(flow, "join");
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "start.result", optional: false }),
        expect.objectContaining({ label: "scored.result", optional: true }),
        expect.objectContaining({ label: "scored.result.score", optional: true }),
        expect.objectContaining({ label: "alternate.result", optional: true }),
      ]),
    );
    expect(options.some((option) => option.label === "alternate.result.anything")).toBe(false);
  });

  it("preserves structured-output field identity when the parent echoes a cloned schema", () => {
    const field = {
      ...newSchemaField(),
      name: "summary",
      value: {
        type: "object" as const,
        fields: [{ ...newSchemaField(), name: "details" }],
      },
    };
    const schema = {
      type: "object" as const,
      properties: {
        summary: {
          type: "object" as const,
          properties: { details: { type: "string" as const } },
          required: ["details"],
          additionalProperties: false as const,
        },
      },
      required: ["summary"],
      additionalProperties: false as const,
    };

    const echoed = objectSchemaToFields(structuredClone(schema), [field]);

    expect(echoed[0]?.id).toBe(field.id);
    expect(echoed[0]?.value.fields[0]?.id).toBe(field.value.fields[0]?.id);
  });

  it("renders prompt variables inline inside one editor instead of creating textareas", () => {
    const flow = createEmptyFlow("prompt_editor");
    flow.spec.graph.start = "writer";
    flow.spec.graph.steps.writer = {
      expert: { ref: "expert:writer@1.0.0" },
      version: "1.0.0",
      prompt: {
        segments: [
          { text: "Use " },
          { variable: { source: "flow-input", path: [] } },
          { text: " and " },
          { variable: { source: "flow-input", path: [] } },
          { text: "." },
        ],
      },
    };
    flow.spec.graph.transitions.writer = { end: true };

    const html = renderToStaticMarkup(
      createElement(PromptTemplateEditor, {
        flow,
        stepId: "writer",
        value: flow.spec.graph.steps.writer.prompt,
        onChange: () => undefined,
      }),
    );

    expect(html.match(/class="flow-prompt-editor"/g)).toHaveLength(1);
    expect(html.match(/class="flow-variable-chip"/g)).toHaveLength(2);
    expect(html).not.toContain("<textarea");
    expect(html).toContain('contentEditable="true"');
    expect(html).toContain('<div class="flow-inspector-field" role="group"');
    expect(html).not.toContain('<label class="flow-inspector-field"><span>Prompt</span>');
  });

  it("merges adjacent prompt text while preserving inline variable order", () => {
    const variable = { source: "flow-input" as const, path: ["goal"] };
    const segments: PragmaFlowPrompt["segments"] = [
      { text: "Review " },
      { text: "this: " },
      { variable },
      { text: "\nCarefully." },
    ];

    expect(normalizePromptSegments(segments)).toEqual([
      { text: "Review this: " },
      { variable },
      { text: "\nCarefully." },
    ]);
  });

  it("preserves a variable inserted inside an existing prompt text node", () => {
    const variable = { source: "flow-input" as const, path: ["goal"] };
    const textNode = (text: string) =>
      ({
        nodeType: 3,
        textContent: text,
        childNodes: [],
      }) as unknown as Node;
    const elementNode = (
      children: readonly Node[],
      encodedVariable?: PragmaFlowPrompt["segments"][number],
    ) =>
      ({
        nodeType: 1,
        textContent: null,
        childNodes: children,
        dataset:
          encodedVariable !== undefined && "variable" in encodedVariable
            ? { flowVariable: encodeURIComponent(JSON.stringify(encodedVariable.variable)) }
            : {},
      }) as unknown as Node;

    const nestedVariableChip = elementNode([textNode("Flow input.goal"), textNode("×")], {
      variable,
    });
    const textSpan = elementNode([
      textNode("Review "),
      nestedVariableChip,
      textNode(" carefully."),
    ]);

    expect(promptSegmentsFromEditorNodes([textSpan])).toEqual([
      { text: "Review " },
      { variable },
      { text: " carefully." },
    ]);
  });

  it("shows actual Runtime environments and requires a model for a Runtime override", () => {
    const resources = runtimeResources();
    const runtime = {
      id: "codex-local",
      isDefault: true,
      kind: "codex",
      displayName: "Codex Local",
      status: "available" as const,
      models: [
        {
          id: "gpt-5.6",
          displayName: "GPT-5.6",
          provider: {
            kind: "runtime-managed" as const,
            id: "openai",
            displayName: "OpenAI",
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(RuntimeBindingEditor, {
        value: undefined,
        allowModel: true,
        targetKind: "expert",
        targetRef: "expert:writer@1.0.0",
        resources,
        runtimes: [runtime],
        onSupportingResource: () => undefined,
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("Codex Local");
    expect(html).not.toContain("Writer Runtime");

    const generated = flowRuntimeProfile(runtime);
    const flow = createEmptyFlow("runtime_override");
    flow.spec.graph.start = "writer";
    flow.spec.graph.steps.writer = {
      expert: { ref: "expert:writer@1.0.0" },
      version: "1.0.0",
      runtime: { ref: `runtime-profile:${generated.metadata.id}@1.0.0` },
    };
    flow.spec.graph.transitions.writer = { end: true };

    expect(validateFlowRuntimeSelections(flow, [...resources, generated])).toEqual([
      expect.objectContaining({
        stepId: "writer",
        message: "Choose a model when overriding the node Runtime.",
      }),
    ]);

    flow.spec.graph.steps.writer.runtime!.modelSelection = {
      model: { providerId: "openai", modelId: "gpt-5.6" },
    };
    expect(validateFlowRuntimeSelections(flow, [...resources, generated])).toEqual([]);
  });
});

function runtimeResources(): PragmaResource[] {
  return [
    {
      apiVersion: "pragma/v2",
      kind: "RuntimeProfile",
      metadata: {
        id: "writer_runtime",
        version: "1.0.0",
        name: "Writer Runtime",
        description: "Writer Runtime",
        tags: ["desktop-managed"],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: {
          runtimeId: "codex-local",
          providerId: "openai",
          model: "gpt-5.6",
        },
      },
    },
    {
      apiVersion: "pragma/v2",
      kind: "Expert",
      metadata: {
        id: "writer",
        version: "1.0.0",
        name: "Writer",
        description: "Writes.",
        tags: [],
      },
      spec: {
        scope: "Write.",
        instructions: "Write.",
        runtime: { ref: "runtime-profile:writer_runtime@1.0.0" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    },
  ];
}

function flowFixture(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v2",
    kind: "Flow",
    metadata: {
      id: "review_flow",
      version: "1.0.0",
      name: "Review flow",
      description: "Review a change",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "review",
        steps: {
          review: {
            expert: { ref: "expert:review@1.0.0" },
            prompt: { segments: [{ text: "Review this change." }] },
            version: "1.0.0",
          },
        },
        loops: {},
        transitions: { review: { end: true } },
      },
    },
  };
}
