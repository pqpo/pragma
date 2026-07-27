import type {
  PragmaFlowDestination,
  PragmaFlowResource,
  PragmaFlowTransition,
  PragmaJsonSchema,
  PragmaResource,
} from "@pragma/interpreter/ast";
import { canonicalPragmaResourceRef } from "@pragma/interpreter/ast";
import dagre from "@dagrejs/dagre";
import { MarkerType, type Connection, type Edge, type Viewport } from "@xyflow/react";

import type { WorkflowLayout } from "../../../../../shared/desktop-api.ts";
import {
  destinationTarget,
  flowStepKind,
  flowStepTarget,
  transitionMode,
  type FlowStep,
  type FlowStepKind,
} from "./flow-model.ts";
import {
  END_NODE_ID,
  FAIL_NODE_ID,
  LOGIC_DRAFT_PREFIX,
  LOGIC_NODE_HEIGHT,
  LOGIC_NODE_PREFIX,
  LOGIC_NODE_WIDTH,
  NODE_HEIGHT,
  NODE_HORIZONTAL_GAP,
  NODE_VERTICAL_GAP,
  NODE_WIDTH,
  START_NODE_ID,
  TERMINAL_HORIZONTAL_GAP,
  TERMINAL_NODE_WIDTH,
  type LogicCanvasNode,
  type StepCanvasNode,
  type WorkflowCanvasNode,
} from "./flow-canvas-types.ts";

export interface ResourceTarget {
  readonly kind: "expert" | "team" | "flow";
  readonly ref: string;
  readonly label: string;
}

export interface FlowExpertOption {
  readonly ref: string;
  readonly name: string;
}

export function targetInputSchema(
  kind: FlowStepKind,
  ref: string,
  resources: readonly PragmaResource[],
): Extract<PragmaJsonSchema, { readonly type: "object" }> | undefined {
  if (kind !== "flow") return undefined;
  const resource = resources.find(
    (candidate) => candidate.kind === "Flow" && canonicalPragmaResourceRef(candidate) === ref,
  );
  return resource?.kind === "Flow" ? resource.spec.input?.schema : undefined;
}

export function resourceTargets(
  resources: readonly PragmaResource[],
  currentFlowId: string,
  expertOptions: readonly FlowExpertOption[] = [],
): readonly ResourceTarget[] {
  const projectTargets = resources.flatMap((resource) => {
    if (resource.kind !== "Expert" && resource.kind !== "ExpertTeam" && resource.kind !== "Flow") {
      return [];
    }
    const kind =
      resource.kind === "Expert"
        ? ("expert" as const)
        : resource.kind === "ExpertTeam"
          ? ("team" as const)
          : ("flow" as const);
    if (kind === "flow" && resource.metadata.id === currentFlowId) return [];
    return [
      {
        kind,
        ref: `${kind}:${resource.metadata.id}`,
        label: resource.metadata.name,
      },
    ];
  });
  const targets = [
    ...expertOptions.map(
      (expert): ResourceTarget => ({ kind: "expert", ref: expert.ref, label: expert.name }),
    ),
    ...projectTargets,
  ];
  return targets.filter(
    (target, index) => targets.findIndex((candidate) => candidate.ref === target.ref) === index,
  );
}

export function defaultStep(
  kind: FlowStepKind,
  targets: readonly ResourceTarget[],
  humanCopy: { readonly optionLabels: readonly [string, string] },
): FlowStep {
  if (kind === "human")
    return {
      human: {
        selectionMode: "single",
        prompt: { segments: [{ text: "" }] },
        options: [
          { value: "option_1", label: humanCopy.optionLabels[0] },
          { value: "option_2", label: humanCopy.optionLabels[1] },
        ],
      },
    };
  const target = targets.find((item) => item.kind === kind)?.ref ?? "";
  return {
    [kind]: { ref: target },
    ...(kind === "expert" || kind === "team" ? { prompt: { segments: [{ text: "" }] } } : {}),
  } as FlowStep;
}

export function setStepReference(
  step: FlowStep,
  kind: Exclude<FlowStepKind, "human">,
  ref: string,
): void {
  const value = step[kind];
  if (value !== undefined) value.ref = ref;
}

export type RouteTransition = Extract<PragmaFlowTransition, { route: string }>;
export type ArrayRouteTransition = Extract<RouteTransition, { branches: readonly unknown[] }>;
export type RouteFieldType = "string" | "number" | "integer" | "boolean" | "string-array";

export interface RouteFieldOption {
  readonly name: string;
  readonly type: RouteFieldType;
  readonly values?: readonly string[] | undefined;
}

export function isRouteTransition(
  transition: PragmaFlowTransition | undefined,
): transition is RouteTransition {
  return typeof transition === "object" && transition !== null && "route" in transition;
}

export function isArrayRouteTransition(
  transition: RouteTransition,
): transition is ArrayRouteTransition {
  return "branches" in transition;
}

export function stepOutputSchema(step: FlowStep | undefined) {
  if (step?.human !== undefined) {
    return {
      type: "object" as const,
      properties: {
        selection:
          step.human.selectionMode === "multiple"
            ? ({ type: "array" as const, items: { type: "string" as const } } as const)
            : ({ type: "string" as const } as const),
      },
      required: ["selection"],
      additionalProperties: false as const,
    };
  }
  return step?.output?.schema;
}

export function logicNodeId(sourceId: string): string {
  return `${LOGIC_NODE_PREFIX}${encodeURIComponent(sourceId)}`;
}

export function logicSourceId(nodeId: string): string | null {
  if (!nodeId.startsWith(LOGIC_NODE_PREFIX) || nodeId.startsWith(LOGIC_DRAFT_PREFIX)) return null;
  try {
    return decodeURIComponent(nodeId.slice(LOGIC_NODE_PREFIX.length));
  } catch {
    return null;
  }
}

export function canvasNodeExists(
  flow: PragmaFlowResource,
  nodeId: string,
  logicDraftIds: readonly string[],
): boolean {
  if (flow.spec.graph.steps[nodeId] !== undefined || logicDraftIds.includes(nodeId)) return true;
  const sourceId = logicSourceId(nodeId);
  return sourceId !== null && isRouteTransition(flow.spec.graph.transitions[sourceId]);
}

export function routeFieldOptions(
  flow: PragmaFlowResource,
  sourceId: string,
): readonly RouteFieldOption[] {
  const step = flow.spec.graph.steps[sourceId];
  const schema = stepOutputSchema(step);
  if (schema?.type !== "object") return [];
  return Object.entries(schema.properties).flatMap<RouteFieldOption>(([name, property]) => {
    if (property.type === "array" && property.items.type === "string") {
      return [
        {
          name,
          type: "string-array" as const,
          ...(step?.human === undefined
            ? {}
            : { values: step.human.options.map((option) => option.value) }),
        },
      ];
    }
    if (!["string", "number", "integer", "boolean"].includes(property.type)) return [];
    return [
      {
        name,
        type: property.type as Exclude<RouteFieldType, "string-array">,
        ...(step?.human === undefined
          ? {}
          : { values: step.human.options.map((option) => option.value) }),
      },
    ];
  });
}

export function createRouteTransition(field: RouteFieldOption | undefined): RouteTransition {
  if (field?.type === "string-array") {
    const values = field.values?.length ? [...field.values] : ["value_1"];
    return {
      route: field.name,
      branches: values.map((value, index) => ({
        id: `branch_${index + 1}`,
        operator: "contains_any",
        values: [value],
        destination: unconnectedDestination(),
      })),
      fallback: unconnectedDestination(),
    };
  }
  if (field?.type === "boolean") {
    return {
      route: field.name,
      cases: {
        true: unconnectedDestination(),
        false: unconnectedDestination(),
      },
    };
  }
  if (field?.values !== undefined && field.values.length > 0) {
    return {
      route: field.name,
      cases: Object.fromEntries(field.values.map((value) => [value, unconnectedDestination()])),
      fallback: unconnectedDestination(),
    };
  }
  return {
    route: field?.name ?? "result",
    cases: { value_1: unconnectedDestination() },
    fallback: unconnectedDestination(),
  };
}

function routeOutputs(
  flow: PragmaFlowResource,
  sourceId: string,
  route: RouteTransition,
): readonly { id: string; label: string }[] {
  const field = routeFieldOptions(flow, sourceId).find(
    (candidate) => candidate.name === route.route,
  );
  if (isArrayRouteTransition(route)) {
    return [
      ...route.branches.map((branch) => ({
        id: `branch:${branch.id}`,
        label: branch.values.join(", "),
      })),
      { id: "fallback", label: "otherwise" },
    ];
  }
  const caseNames = field?.type === "boolean" ? ["true", "false"] : Object.keys(route.cases);
  return [
    ...caseNames.map((key) => ({ id: `case:${key}`, label: key })),
    ...(field?.type === "boolean" ? [] : [{ id: "fallback", label: "otherwise" }]),
  ];
}

export function nextCaseKey(cases: Readonly<Record<string, PragmaFlowDestination>>): string {
  let index = 1;
  let key = `value_${index}`;
  while (cases[key] !== undefined) {
    index += 1;
    key = `value_${index}`;
  }
  return key;
}

export function nextArrayBranchId(
  branches: readonly ArrayRouteTransition["branches"][number][],
): string {
  let index = 1;
  let id = `branch_${index}`;
  const existing = new Set(branches.map((branch) => branch.id));
  while (existing.has(id)) {
    index += 1;
    id = `branch_${index}`;
  }
  return id;
}

export function moveArrayBranch(
  branches: readonly ArrayRouteTransition["branches"][number][],
  from: number,
  to: number,
): ArrayRouteTransition["branches"][number][] {
  if (from === to || to < 0 || to >= branches.length) return [...branches];
  const next = [...branches];
  const [branch] = next.splice(from, 1);
  if (branch !== undefined) next.splice(to, 0, branch);
  return next;
}

export function renameRouteCase(
  cases: Readonly<Record<string, PragmaFlowDestination>>,
  previousKey: string,
  nextKey: string,
): Record<string, PragmaFlowDestination> {
  if (previousKey === nextKey || nextKey.trim() === "" || cases[nextKey] !== undefined) {
    return { ...cases };
  }
  return Object.fromEntries(
    Object.entries(cases).map(([key, destination]) => [
      key === previousKey ? nextKey : key,
      destination,
    ]),
  );
}

export function destinationLabel(destination: PragmaFlowDestination): string {
  if (typeof destination === "string") return destination;
  if ("goto" in destination) return destination.goto === "" ? "Not connected" : destination.goto;
  if ("end" in destination) return "End";
  if ("fail" in destination) return "Fail";
  return `${destination.repeat.goto} · ${destination.repeat.loop}`;
}

export function unconnectedDestination(): PragmaFlowDestination {
  return { goto: "" };
}

export function isUnconnectedDestination(destination: PragmaFlowDestination): boolean {
  return typeof destination === "object" && "goto" in destination && destination.goto === "";
}

export function nextStepId(flow: PragmaFlowResource, kind: FlowStepKind): string {
  let index = 1;
  while (flow.spec.graph.steps[`${kind}_${index}`] !== undefined) index += 1;
  return `${kind}_${index}`;
}

export function nextFlowResourceId(resources: readonly PragmaResource[]): string {
  const ids = new Set(
    resources
      .filter((resource) => resource.kind === "Flow")
      .map((resource) => resource.metadata.id),
  );
  let index = 1;
  while (ids.has(index === 1 ? "untitled_flow" : `untitled_flow_${index}`)) index += 1;
  return index === 1 ? "untitled_flow" : `untitled_flow_${index}`;
}

export function connectionDestination(targetId: string): PragmaFlowDestination | null {
  if (targetId === END_NODE_ID) return { end: true };
  if (targetId === FAIL_NODE_ID) return { fail: "Flow failed" };
  if (targetId === START_NODE_ID) return null;
  return { goto: targetId };
}

export function normalizeConnectionDestination(
  flow: PragmaFlowResource,
  sourceId: string,
  destination: PragmaFlowDestination,
): PragmaFlowDestination {
  const target = destinationTarget(destination);
  if (target === null || !wouldCreateCycle(flow, sourceId, target)) return destination;
  const baseId = `loop_${sourceId}_${target}`.replace(/[^A-Za-z0-9_-]/g, "_");
  let loopId = baseId;
  let suffix = 2;
  while (
    flow.spec.graph.loops[loopId] !== undefined &&
    flow.spec.graph.loops[loopId]?.entry !== target
  ) {
    loopId = `${baseId}_${suffix}`;
    suffix += 1;
  }
  flow.spec.graph.loops[loopId] ??= {
    entry: target,
    maxIterations: 3,
    onLimit: { fail: `Loop ${loopId} reached its limit.` },
  };
  return { repeat: { loop: loopId, goto: target } };
}

function wouldCreateCycle(flow: PragmaFlowResource, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  const seen = new Set<string>();
  const pending = [targetId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === sourceId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const transition = flow.spec.graph.transitions[current];
    if (transition === undefined) continue;
    for (const destination of transitionDestinations(transition)) {
      const next = destinationTarget(destination);
      if (next !== null) pending.push(next);
    }
  }
  return false;
}

export function applyConnection(
  flow: PragmaFlowResource,
  connection: Connection,
  destination: PragmaFlowDestination,
): void {
  const canvasSource = connection.source;
  if (canvasSource === null) return;
  if (canvasSource === START_NODE_ID) {
    const target = destinationTarget(destination);
    if (target !== null) flow.spec.graph.start = target;
    return;
  }
  const routeSource = logicSourceId(canvasSource);
  const source = routeSource ?? canvasSource;
  if (flow.spec.graph.steps[source] === undefined) return;
  const current = flow.spec.graph.transitions[source];
  const handle = connection.sourceHandle ?? "default";
  let previous: PragmaFlowDestination | undefined;
  if (routeSource !== null && handle.startsWith("branch:") && isRouteTransition(current)) {
    if (!isArrayRouteTransition(current)) return;
    const branch = current.branches.find((candidate) => candidate.id === handle.slice(7));
    if (branch === undefined) return;
    previous = branch.destination;
    branch.destination = destination;
  } else if (routeSource !== null && handle.startsWith("case:") && isRouteTransition(current)) {
    if (isArrayRouteTransition(current)) return;
    const caseName = handle.slice(5);
    previous = current.cases[caseName];
    current.cases[caseName] = destination;
  } else if (routeSource !== null && handle === "fallback" && isRouteTransition(current)) {
    previous = current.fallback;
    current.fallback = destination;
  } else {
    if (routeSource !== null) return;
    if (current !== undefined && !isRouteTransition(current)) {
      previous = current;
    }
    flow.spec.graph.transitions[source] = destination;
  }
  removeOrphanedLoop(flow, previous);
}

export function removeEdgeFromFlow(flow: PragmaFlowResource, edge: Edge): void {
  if (edge.id === "start-edge") {
    flow.spec.graph.start = "";
    return;
  }
  if (edge.id.endsWith(":logic-input")) {
    const route = flow.spec.graph.transitions[edge.source];
    if (!isRouteTransition(route)) return;
    delete flow.spec.graph.transitions[edge.source];
    for (const destination of transitionDestinations(route)) {
      removeOrphanedLoop(flow, destination);
    }
    return;
  }
  const routeSource = logicSourceId(edge.source);
  const source = routeSource ?? edge.source;
  const transition = flow.spec.graph.transitions[source];
  if (transition === undefined) return;
  let removed: PragmaFlowDestination | undefined;
  if (routeSource !== null && isRouteTransition(transition)) {
    if (edge.sourceHandle?.startsWith("branch:")) {
      if (!isArrayRouteTransition(transition)) return;
      const branch = transition.branches.find(
        (candidate) => candidate.id === edge.sourceHandle?.slice(7),
      );
      if (branch === undefined) return;
      removed = branch.destination;
      branch.destination = unconnectedDestination();
    } else if (edge.sourceHandle?.startsWith("case:")) {
      if (isArrayRouteTransition(transition)) return;
      const caseName = edge.sourceHandle.slice(5);
      removed = transition.cases[caseName];
      transition.cases[caseName] = unconnectedDestination();
    } else if (edge.sourceHandle === "fallback") {
      removed = transition.fallback;
      transition.fallback = unconnectedDestination();
    }
  } else {
    if (isRouteTransition(transition)) return;
    removed = transition;
    delete flow.spec.graph.transitions[source];
  }
  removeOrphanedLoop(flow, removed);
}

export function edgeDestination(
  flow: PragmaFlowResource,
  edge: Edge,
): PragmaFlowDestination | undefined {
  if (edge.id === "start-edge") {
    return flow.spec.graph.start === "" ? undefined : { goto: flow.spec.graph.start };
  }
  const routeSource = logicSourceId(edge.source);
  const source = routeSource ?? edge.source;
  const transition = flow.spec.graph.transitions[source];
  if (transition === undefined) return undefined;
  if (routeSource !== null && isRouteTransition(transition)) {
    if (edge.sourceHandle?.startsWith("branch:")) {
      if (!isArrayRouteTransition(transition)) return undefined;
      return transition.branches.find((branch) => branch.id === edge.sourceHandle?.slice(7))
        ?.destination;
    }
    if (edge.sourceHandle?.startsWith("case:")) {
      if (isArrayRouteTransition(transition)) return undefined;
      return transition.cases[edge.sourceHandle.slice(5)];
    }
    if (edge.sourceHandle === "fallback") return transition.fallback;
    return undefined;
  }
  return isRouteTransition(transition) ? undefined : transition;
}

export function setEdgeDestination(
  flow: PragmaFlowResource,
  edge: Edge,
  destination: PragmaFlowDestination,
): void {
  const routeSource = logicSourceId(edge.source);
  const source = routeSource ?? edge.source;
  const transition = flow.spec.graph.transitions[source];
  if (routeSource !== null && isRouteTransition(transition)) {
    if (edge.sourceHandle?.startsWith("branch:")) {
      if (!isArrayRouteTransition(transition)) return;
      const branch = transition.branches.find(
        (candidate) => candidate.id === edge.sourceHandle?.slice(7),
      );
      if (branch !== undefined) branch.destination = destination;
    } else if (edge.sourceHandle?.startsWith("case:")) {
      if (isArrayRouteTransition(transition)) return;
      transition.cases[edge.sourceHandle.slice(5)] = destination;
    } else if (edge.sourceHandle === "fallback") {
      transition.fallback = destination;
    }
    return;
  }
  if (!isRouteTransition(transition)) flow.spec.graph.transitions[source] = destination;
}

export type FlowLimitTarget = NonNullable<
  PragmaFlowResource["spec"]["graph"]["loops"][string]["onLimit"]
>;

export function flowTargetSelectValue(target: FlowLimitTarget | undefined): string {
  if (target === undefined || (typeof target === "object" && "end" in target)) return "end";
  if (typeof target === "object" && "fail" in target) return "fail";
  return `goto:${typeof target === "string" ? target : target.goto}`;
}

export function flowTargetFromSelect(value: string): FlowLimitTarget {
  if (value === "end") return { end: true };
  if (value === "fail") return { fail: "Loop reached its limit." };
  return { goto: value.slice("goto:".length) };
}

export function removeOrphanedLoop(
  flow: PragmaFlowResource,
  destination: PragmaFlowDestination | undefined,
): void {
  if (destination === undefined || typeof destination === "string" || !("repeat" in destination)) {
    return;
  }
  const loopId = destination.repeat.loop;
  const stillReferenced = Object.values(flow.spec.graph.transitions).some((transition) =>
    transitionDestinations(transition).some(
      (candidate) =>
        typeof candidate === "object" && "repeat" in candidate && candidate.repeat.loop === loopId,
    ),
  );
  if (!stillReferenced) delete flow.spec.graph.loops[loopId];
}

export function transitionDestinations(
  transition: PragmaFlowTransition,
): readonly PragmaFlowDestination[] {
  if (typeof transition !== "object" || !("route" in transition)) return [transition];
  return [
    ...("branches" in transition
      ? transition.branches.map((branch) => branch.destination)
      : Object.values(transition.cases)),
    ...(transition.fallback ? [transition.fallback] : []),
  ];
}

export function buildCanvasNodes(
  flow: PragmaFlowResource,
  suppliedPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
  invalidStepIds: ReadonlySet<string> = new Set(),
  selectedNodeId: string | null = null,
  logicDraftIds: readonly string[] = [],
): WorkflowCanvasNode[] {
  const automatic = automaticPositions(flow);
  const stepIds = Object.keys(flow.spec.graph.steps);
  const routeSourceIds = Object.entries(flow.spec.graph.transitions)
    .filter(([, transition]) => isRouteTransition(transition))
    .map(([sourceId]) => sourceId);
  const logicIds = routeSourceIds.map(logicNodeId);
  const canvasIds = [...stepIds, ...logicIds, ...logicDraftIds];
  const positions = Object.fromEntries(
    canvasIds.map((id, index) => [
      id,
      suppliedPositions[id] ??
        automatic[id] ?? {
          x: 280 + (index % 3) * (NODE_WIDTH + NODE_HORIZONTAL_GAP),
          y: 120 + Math.floor(index / 3) * (NODE_HEIGHT + NODE_VERTICAL_GAP),
        },
    ]),
  );
  const semantic = stepIds.map((id): StepCanvasNode => {
    const step = flow.spec.graph.steps[id]!;
    return {
      id,
      type: "step",
      position: positions[id]!,
      deletable: false,
      selected: id === selectedNodeId,
      data: {
        kind: flowStepKind(step),
        label: id,
        subtitle: flowStepTarget(step),
        outputs: [{ id: "default", label: "result" }],
        invalid: invalidStepIds.has(id),
      },
    };
  });
  const logicNodes: LogicCanvasNode[] = routeSourceIds.map((sourceId) => {
    const transition = flow.spec.graph.transitions[sourceId] as RouteTransition;
    const id = logicNodeId(sourceId);
    return {
      id,
      type: "logic",
      position: positions[id]!,
      deletable: false,
      selected: id === selectedNodeId,
      data: {
        sourceId,
        label: transition.route,
        fieldLabel: `${sourceId}.result.${transition.route}`,
        outputs: routeOutputs(flow, sourceId, transition),
        invalid: invalidStepIds.has(sourceId),
      },
    };
  });
  const draftNodes: LogicCanvasNode[] = logicDraftIds.map((id) => ({
    id,
    type: "logic",
    position: positions[id]!,
    deletable: false,
    selected: id === selectedNodeId,
    data: {
      sourceId: null,
      label: "Condition",
      fieldLabel: "Connect an upstream node",
      outputs: [],
      invalid: true,
    },
  }));
  const startPosition = positions[flow.spec.graph.start] ?? { x: 0, y: 0 };
  const maxX = Math.max(...Object.values(positions).map((position) => position.x), 0);
  const averageY =
    Object.values(positions).length === 0
      ? 0
      : Object.values(positions).reduce((total, position) => total + position.y, 0) /
        Object.values(positions).length;
  const showFail = flowUsesFail(flow);
  const terminalX = maxX + NODE_WIDTH + TERMINAL_HORIZONTAL_GAP;
  const defaultStartPosition = {
    x: startPosition.x - TERMINAL_NODE_WIDTH - TERMINAL_HORIZONTAL_GAP,
    y: startPosition.y + 25,
  };
  const defaultEndPosition = { x: terminalX, y: showFail ? averageY - 35 : averageY + 25 };
  const defaultFailPosition = { x: terminalX, y: averageY + 70 };
  const terminalNodes: WorkflowCanvasNode[] = [
    {
      id: START_NODE_ID,
      type: "terminal",
      position: suppliedPositions[START_NODE_ID] ?? defaultStartPosition,
      draggable: true,
      deletable: false,
      selected: START_NODE_ID === selectedNodeId,
      data: { label: "Start", tone: "start" },
    },
    ...semantic,
    ...logicNodes,
    ...draftNodes,
    {
      id: END_NODE_ID,
      type: "terminal",
      position: suppliedPositions[END_NODE_ID] ?? defaultEndPosition,
      draggable: true,
      deletable: false,
      selected: END_NODE_ID === selectedNodeId,
      data: { label: "End", tone: "end" },
    },
  ];
  if (showFail) {
    terminalNodes.push({
      id: FAIL_NODE_ID,
      type: "terminal",
      position: suppliedPositions[FAIL_NODE_ID] ?? defaultFailPosition,
      draggable: true,
      deletable: false,
      selected: FAIL_NODE_ID === selectedNodeId,
      data: { label: "Fail", tone: "fail" },
    });
  }
  return terminalNodes;
}

export function inspectorNodeId(
  node: Pick<WorkflowCanvasNode, "id" | "type"> | undefined,
): string | null {
  return node?.type === "step" || node?.type === "logic" || node?.type === "terminal"
    ? node.id
    : null;
}

export function rebuildCanvasNodesPreservingSelection(
  flow: PragmaFlowResource,
  currentNodes: readonly WorkflowCanvasNode[],
  invalidStepIds: ReadonlySet<string> = new Set(),
  logicDraftIds: readonly string[] = [],
): WorkflowCanvasNode[] {
  const selectedNodeId = inspectorNodeId(currentNodes.find((node) => node.selected));
  return buildCanvasNodes(
    flow,
    canvasPositions(currentNodes),
    invalidStepIds,
    selectedNodeId,
    logicDraftIds,
  );
}

export function buildCanvasEdges(flow: PragmaFlowResource): Edge[] {
  const edges: Edge[] = [];
  if (flow.spec.graph.steps[flow.spec.graph.start] !== undefined) {
    edges.push({
      id: "start-edge",
      source: START_NODE_ID,
      sourceHandle: "start",
      target: flow.spec.graph.start,
      targetHandle: "target",
      type: "workflow",
      animated: true,
      deletable: true,
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  }
  for (const [source, transition] of Object.entries(flow.spec.graph.transitions)) {
    if (isRouteTransition(transition)) {
      const logicId = logicNodeId(source);
      edges.push({
        id: `${source}:logic-input`,
        source,
        sourceHandle: "default",
        target: logicId,
        targetHandle: "target",
        label: "result",
        type: "workflow",
        deletable: true,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
      if (isArrayRouteTransition(transition)) {
        for (const branch of transition.branches) {
          const edge = destinationEdge(
            logicId,
            `branch:${branch.id}`,
            branch.destination,
            branch.values.join(", "),
          );
          if (edge !== null) edges.push(edge);
        }
      } else {
        for (const [caseName, destination] of Object.entries(transition.cases)) {
          const edge = destinationEdge(logicId, `case:${caseName}`, destination, caseName);
          if (edge !== null) edges.push(edge);
        }
      }
      if (transition.fallback !== undefined) {
        const edge = destinationEdge(logicId, "fallback", transition.fallback, "otherwise");
        if (edge !== null) edges.push(edge);
      }
    } else {
      const edge = destinationEdge(source, "default", transition, transitionMode(transition));
      if (edge !== null) edges.push(edge);
    }
  }
  return edges;
}

function flowUsesFail(flow: PragmaFlowResource): boolean {
  const transitionFails = Object.values(flow.spec.graph.transitions).some((transition) =>
    transitionDestinations(transition).some(isFailDestination),
  );
  return (
    transitionFails ||
    Object.values(flow.spec.graph.loops).some(
      (loop) => loop.onLimit !== undefined && isFailDestination(loop.onLimit),
    )
  );
}

function isFailDestination(destination: PragmaFlowDestination): boolean {
  return typeof destination === "object" && "fail" in destination;
}

function destinationEdge(
  source: string,
  sourceHandle: string,
  destination: PragmaFlowDestination,
  label: string,
): Edge | null {
  if (isUnconnectedDestination(destination)) return null;
  const target =
    destinationTarget(destination) ??
    (typeof destination === "object" && "fail" in destination ? FAIL_NODE_ID : END_NODE_ID);
  const repeat = typeof destination === "object" && "repeat" in destination;
  return {
    id: `${source}:${sourceHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle: "target",
    label: repeat ? `${label} · ${destination.repeat.loop}` : label,
    type: "workflow",
    deletable: true,
    animated: repeat,
    ...(repeat ? { className: "is-repeat-edge" } : {}),
    markerEnd: { type: MarkerType.ArrowClosed },
  };
}

export function automaticPositions(
  flow: PragmaFlowResource,
): Record<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 110, nodesep: 54, marginx: 20, marginy: 20 });
  for (const id of Object.keys(flow.spec.graph.steps))
    graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const [source, transition] of Object.entries(flow.spec.graph.transitions)) {
    const route = isRouteTransition(transition);
    const graphSource = route ? logicNodeId(source) : source;
    if (route) {
      graph.setNode(graphSource, { width: LOGIC_NODE_WIDTH, height: LOGIC_NODE_HEIGHT });
      graph.setEdge(source, graphSource);
    }
    const destinations = route
      ? [
          ...("branches" in transition
            ? transition.branches.map((branch) => branch.destination)
            : Object.values(transition.cases)),
          transition.fallback,
        ].filter((value): value is PragmaFlowDestination => value !== undefined)
      : [transition];
    for (const destination of destinations) {
      const target = destinationTarget(destination);
      if (target !== null && flow.spec.graph.steps[target] !== undefined)
        graph.setEdge(graphSource, target);
    }
  }
  dagre.layout(graph);
  return Object.fromEntries(
    [
      ...Object.keys(flow.spec.graph.steps),
      ...Object.keys(flow.spec.graph.transitions)
        .filter((id) => isRouteTransition(flow.spec.graph.transitions[id]))
        .map(logicNodeId),
    ].map((id) => {
      const position = graph.node(id) as { x: number; y: number };
      const logic = logicSourceId(id) !== null;
      return [
        id,
        {
          x: position.x - (logic ? LOGIC_NODE_WIDTH : NODE_WIDTH) / 2,
          y: position.y - (logic ? LOGIC_NODE_HEIGHT : NODE_HEIGHT) / 2,
        },
      ];
    }),
  );
}

export function canvasPositions(
  nodes: readonly WorkflowCanvasNode[],
): Record<string, { x: number; y: number }> {
  return Object.fromEntries(nodes.map((node) => [node.id, node.position]));
}

export function nextAvailableNodePosition(
  existing: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
  preferred: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const occupied = Object.values(existing);
  const cellWidth = NODE_WIDTH + NODE_HORIZONTAL_GAP;
  const cellHeight = NODE_HEIGHT + NODE_VERTICAL_GAP;
  const isAvailable = (candidate: { readonly x: number; readonly y: number }) =>
    occupied.every(
      (position) =>
        Math.abs(candidate.x - position.x) >= cellWidth ||
        Math.abs(candidate.y - position.y) >= cellHeight,
    );

  if (isAvailable(preferred)) return { ...preferred };
  for (let ring = 1; ring <= 50; ring += 1) {
    for (const [column, row] of gridRing(ring)) {
      const candidate = {
        x: preferred.x + column * cellWidth,
        y: preferred.y + row * cellHeight,
      };
      if (isAvailable(candidate)) return candidate;
    }
  }
  return {
    x: preferred.x + occupied.length * cellWidth,
    y: preferred.y,
  };
}

function gridRing(ring: number): readonly (readonly [number, number])[] {
  const offsets: [number, number][] = [];
  for (let row = 0; row <= ring; row += 1) offsets.push([ring, row]);
  for (let column = ring - 1; column >= -ring; column -= 1) offsets.push([column, ring]);
  for (let row = ring - 1; row >= -ring; row -= 1) offsets.push([-ring, row]);
  for (let column = -ring + 1; column <= ring; column += 1) offsets.push([column, -ring]);
  for (let row = -ring + 1; row < 0; row += 1) offsets.push([ring, row]);
  return offsets;
}

export function workflowLayoutFromCanvas(input: {
  readonly projectId: string;
  readonly flow: PragmaFlowResource;
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly viewport?: Viewport | undefined;
  readonly updatedAt?: string | undefined;
}): WorkflowLayout {
  return {
    schemaVersion: "pragma.desktop-flow-layout/v2",
    projectId: input.projectId,
    flowId: input.flow.metadata.id,
    nodes: { ...input.positions },
    viewport: input.viewport ?? { x: 0, y: 0, zoom: 1 },
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}
