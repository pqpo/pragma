import {
  analyzeControlFlowGraph,
  analyzeControlFlowNodeAvailability,
  type ControlFlowEdge,
  type ControlFlowGraphIssue,
  type ControlFlowNodeAvailability,
} from "@pragma/shared";

import type {
  PragmaFlowDestination,
  PragmaFlowResource,
  PragmaFlowTarget,
} from "./pragma-dsl.schema.ts";

export interface PragmaFlowGraphIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly stepId?: string | undefined;
  readonly loopId?: string | undefined;
}

export interface PragmaFlowGraphAnalysis {
  readonly issues: readonly PragmaFlowGraphIssue[];
  readonly loopMembers: ReadonlyMap<string, ReadonlySet<string>>;
}

export function analyzePragmaFlowGraph(resource: PragmaFlowResource): PragmaFlowGraphAnalysis {
  const graph = resource.spec.graph;
  const localIssues: PragmaFlowGraphIssue[] = [];
  const edges: ControlFlowEdge[] = [];
  const addDestination = (source: string, destination: PragmaFlowDestination): void => {
    if (typeof destination === "string") {
      edges.push({ source, target: destination, kind: "ordinary" });
    } else if ("goto" in destination) {
      edges.push({ source, target: destination.goto, kind: "ordinary" });
    } else if ("repeat" in destination) {
      edges.push({
        source,
        target: destination.repeat.goto,
        kind: "repeat",
        loopId: destination.repeat.loop,
      });
    }
  };
  for (const [source, transition] of Object.entries(graph.transitions)) {
    if (typeof transition === "object" && "route" in transition) {
      const destinations =
        "branches" in transition
          ? transition.branches.map((branch) => branch.destination)
          : Object.values(transition.cases);
      if (destinations.length === 0 && transition.fallback === undefined) {
        localIssues.push({
          code: "flow.graph.route_empty",
          message: `Flow route has no cases or fallback: ${source}`,
          path: ["spec", "graph", "transitions", source],
          stepId: source,
        });
      }
      for (const destination of destinations) addDestination(source, destination);
      if (transition.fallback !== undefined) addDestination(source, transition.fallback);
    } else {
      addDestination(source, transition);
    }
  }
  const analysis = analyzeControlFlowGraph({
    nodes: new Set(Object.keys(graph.steps)),
    start: graph.start,
    transitionSources: new Set(Object.keys(graph.transitions)),
    edges,
    loops: Object.entries(graph.loops).map(([id, loop]) => ({
      id,
      entry: loop.entry,
      onLimitTarget: readTargetStepId(loop.onLimit),
    })),
  });
  return {
    issues: [...localIssues, ...analysis.issues.map(toPragmaIssue)],
    loopMembers: analysis.loopMembers,
  };
}

export function analyzePragmaFlowNodeAvailability(
  resource: PragmaFlowResource,
  targetStepId: string,
): ControlFlowNodeAvailability {
  const graph = resource.spec.graph;
  const edges: ControlFlowEdge[] = [];
  const add = (source: string, destination: PragmaFlowDestination): void => {
    if (typeof destination === "string") {
      edges.push({ source, target: destination, kind: "ordinary" });
    } else if ("goto" in destination) {
      edges.push({ source, target: destination.goto, kind: "ordinary" });
    } else if ("repeat" in destination) {
      edges.push({
        source,
        target: destination.repeat.goto,
        kind: "repeat",
        loopId: destination.repeat.loop,
      });
    }
  };
  for (const [source, transition] of Object.entries(graph.transitions)) {
    if (typeof transition === "object" && "route" in transition) {
      const destinations =
        "branches" in transition
          ? transition.branches.map((branch) => branch.destination)
          : Object.values(transition.cases);
      destinations.forEach((destination) => add(source, destination));
      if (transition.fallback !== undefined) add(source, transition.fallback);
    } else {
      add(source, transition);
    }
  }
  return analyzeControlFlowNodeAvailability(
    { nodes: new Set(Object.keys(graph.steps)), start: graph.start, edges },
    targetStepId,
  );
}

function toPragmaIssue(issue: ControlFlowGraphIssue): PragmaFlowGraphIssue {
  const path =
    issue.loopId === undefined
      ? issue.nodeId === undefined
        ? ["spec", "graph"]
        : ["spec", "graph", "steps", issue.nodeId]
      : ["spec", "graph", "loops", issue.loopId];
  return {
    code: `flow.graph.${issue.code}`,
    message: issue.message,
    path,
    ...(issue.nodeId === undefined ? {} : { stepId: issue.nodeId }),
    ...(issue.loopId === undefined ? {} : { loopId: issue.loopId }),
  };
}

function readTargetStepId(target: PragmaFlowTarget | undefined): string | undefined {
  if (target === undefined || typeof target !== "object") return target;
  return "goto" in target ? target.goto : undefined;
}
