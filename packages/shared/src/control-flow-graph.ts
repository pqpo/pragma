export type ControlFlowEdge =
  | {
      readonly source: string;
      readonly target: string;
      readonly kind: "ordinary";
    }
  | {
      readonly source: string;
      readonly target: string;
      readonly kind: "repeat";
      readonly loopId: string;
    };

export interface ControlFlowLoop {
  readonly id: string;
  readonly entry: string;
  readonly members?: ReadonlySet<string> | undefined;
  readonly onLimitTarget?: string | undefined;
}

export interface ControlFlowGraph {
  readonly nodes: ReadonlySet<string>;
  readonly start: string;
  readonly transitionSources: ReadonlySet<string>;
  readonly edges: readonly ControlFlowEdge[];
  readonly loops: readonly ControlFlowLoop[];
}

export interface ControlFlowGraphIssue {
  readonly code:
    | "start.unknown"
    | "transition.missing"
    | "transition.source_unknown"
    | "transition.target_unknown"
    | "step.unreachable"
    | "cycle.ordinary"
    | "repeat.loop_unknown"
    | "repeat.target_mismatch"
    | "loop.entry_unknown"
    | "loop.region_ambiguous"
    | "loop.non_entry_incoming"
    | "loop.repeat_missing"
    | "loop.repeat_mismatch"
    | "loop.members_mismatch"
    | "loop.on_limit_unknown"
    | "loop.on_limit_not_exit"
    | "loop.not_cyclic";
  readonly message: string;
  readonly nodeId?: string | undefined;
  readonly loopId?: string | undefined;
}

export interface ControlFlowGraphAnalysis {
  readonly issues: readonly ControlFlowGraphIssue[];
  readonly loopMembers: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ControlFlowNodeAvailability {
  readonly upstream: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

/**
 * Derive nodes whose latest result may be visible when `target` runs.
 *
 * `upstream` includes nodes that can reach the target, including through an explicit repeat edge.
 * `required` is the subset that dominates the target and therefore runs on every path from start.
 */
export function analyzeControlFlowNodeAvailability(
  graph: Pick<ControlFlowGraph, "nodes" | "start" | "edges">,
  target: string,
): ControlFlowNodeAvailability {
  if (!graph.nodes.has(target)) return { upstream: new Set(), required: new Set() };
  const incoming = new Map([...graph.nodes].map((node) => [node, new Set<string>()]));
  for (const edge of graph.edges) {
    if (graph.nodes.has(edge.source) && graph.nodes.has(edge.target)) {
      incoming.get(edge.target)?.add(edge.source);
    }
  }

  const upstream = new Set<string>();
  const pending = [...(incoming.get(target) ?? [])];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node === target || upstream.has(node)) continue;
    upstream.add(node);
    pending.push(...(incoming.get(node) ?? []));
  }

  const all = new Set(graph.nodes);
  const dominators = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    dominators.set(node, node === graph.start ? new Set([node]) : new Set(all));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (node === graph.start) continue;
      const predecessors = [...(incoming.get(node) ?? [])];
      const intersection =
        predecessors.length === 0
          ? new Set<string>()
          : intersectSets(predecessors.map((predecessor) => dominators.get(predecessor)!));
      intersection.add(node);
      if (!sameMembers(intersection, dominators.get(node)!)) {
        dominators.set(node, intersection);
        changed = true;
      }
    }
  }
  const required = new Set(
    [...(dominators.get(target) ?? [])].filter((node) => node !== target && upstream.has(node)),
  );
  return { upstream, required };
}

/** Analyze a bounded control-flow graph without depending on a runtime or DSL representation. */
export function analyzeControlFlowGraph(graph: ControlFlowGraph): ControlFlowGraphAnalysis {
  const issues: ControlFlowGraphIssue[] = [];
  const loops = new Map(graph.loops.map((loop) => [loop.id, loop]));
  const validEdges: ControlFlowEdge[] = [];

  if (!graph.nodes.has(graph.start)) {
    issues.push({
      code: "start.unknown",
      message: `Unknown Flow start step: ${graph.start}`,
      nodeId: graph.start,
    });
  }
  for (const nodeId of graph.nodes) {
    if (!graph.transitionSources.has(nodeId)) {
      issues.push({
        code: "transition.missing",
        message: `Flow step has no transition: ${nodeId}`,
        nodeId,
      });
    }
  }
  for (const source of graph.transitionSources) {
    if (!graph.nodes.has(source)) {
      issues.push({
        code: "transition.source_unknown",
        message: `Transition source is unknown: ${source}`,
        nodeId: source,
      });
    }
  }
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.source)) continue;
    if (!graph.nodes.has(edge.target)) {
      issues.push({
        code: "transition.target_unknown",
        message: `Transition target is unknown: ${edge.target}`,
        nodeId: edge.source,
      });
      continue;
    }
    validEdges.push(edge);
    if (edge.kind !== "repeat") continue;
    const loop = loops.get(edge.loopId);
    if (loop === undefined) {
      issues.push({
        code: "repeat.loop_unknown",
        message: `Unknown Flow loop: ${edge.loopId}`,
        nodeId: edge.source,
        loopId: edge.loopId,
      });
    } else if (edge.target !== loop.entry) {
      issues.push({
        code: "repeat.target_mismatch",
        message: `Loop ${edge.loopId} repeat must target ${loop.entry}.`,
        nodeId: edge.source,
        loopId: edge.loopId,
      });
    }
  }
  for (const loop of graph.loops) {
    if (!graph.nodes.has(loop.entry)) {
      issues.push({
        code: "loop.entry_unknown",
        message: `Loop entry is unknown: ${loop.entry}`,
        loopId: loop.id,
        nodeId: loop.entry,
      });
    }
    if (loop.onLimitTarget !== undefined && !graph.nodes.has(loop.onLimitTarget)) {
      issues.push({
        code: "loop.on_limit_unknown",
        message: `Loop ${loop.id} onLimit target is unknown: ${loop.onLimitTarget}.`,
        loopId: loop.id,
        nodeId: loop.onLimitTarget,
      });
    }
  }

  const ordinaryEdges = validEdges.filter((edge) => edge.kind === "ordinary");
  const onLimitEdges = graph.loops.flatMap((loop): ControlFlowEdge[] => {
    if (loop.onLimitTarget === undefined || !graph.nodes.has(loop.onLimitTarget)) return [];
    return validEdges.flatMap((edge) =>
      edge.kind === "repeat" && edge.loopId === loop.id
        ? [{ source: edge.source, target: loop.onLimitTarget!, kind: "ordinary" as const }]
        : [],
    );
  });
  if (hasCycle(graph.nodes, toAdjacency(graph.nodes, [...ordinaryEdges, ...onLimitEdges]))) {
    issues.push({
      code: "cycle.ordinary",
      message: "Flow contains a cycle that is not broken by an explicit repeat edge.",
    });
  }

  const adjacency = toAdjacency(graph.nodes, validEdges);
  const loopMembers = new Map<string, ReadonlySet<string>>();
  const components = stronglyConnectedComponents(graph.nodes, adjacency).filter(
    (component) =>
      component.size > 1 || [...component].some((nodeId) => adjacency.get(nodeId)?.has(nodeId)),
  );
  const loopsInCyclicRegions = new Set<string>();
  for (const component of components) {
    const matching = graph.loops.filter((loop) => component.has(loop.entry));
    for (const loop of matching) loopsInCyclicRegions.add(loop.id);
    if (matching.length !== 1) {
      issues.push({
        code: "loop.region_ambiguous",
        message: "Every cyclic Flow region must have exactly one Loop.",
      });
      continue;
    }
    const loop = matching[0]!;
    loopMembers.set(loop.id, component);
    if (
      loop.members !== undefined &&
      (!sameMembers(loop.members, component) || !loop.members.has(loop.entry))
    ) {
      issues.push({
        code: "loop.members_mismatch",
        message: `Loop ${loop.id} declared members do not match its cyclic region.`,
        loopId: loop.id,
      });
    }
    for (const [source, targets] of adjacency) {
      if (component.has(source)) continue;
      for (const target of targets) {
        if (component.has(target) && target !== loop.entry) {
          issues.push({
            code: "loop.non_entry_incoming",
            message: `Loop ${loop.id} has a non-entry incoming edge to ${target}.`,
            loopId: loop.id,
            nodeId: target,
          });
        }
      }
    }
    const repeats = validEdges.filter(
      (edge): edge is Extract<ControlFlowEdge, { readonly kind: "repeat" }> =>
        edge.kind === "repeat" && component.has(edge.source) && component.has(edge.target),
    );
    if (repeats.length === 0) {
      issues.push({
        code: "loop.repeat_missing",
        message: `Loop ${loop.id} has no explicit repeat edge.`,
        loopId: loop.id,
      });
    }
    for (const edge of repeats) {
      if (edge.loopId !== loop.id) {
        issues.push({
          code: "loop.repeat_mismatch",
          message: `Repeat edge ${edge.source} -> ${edge.target} belongs to the wrong Loop ${edge.loopId}.`,
          loopId: edge.loopId,
          nodeId: edge.source,
        });
      }
    }
    if (loop.onLimitTarget !== undefined && component.has(loop.onLimitTarget)) {
      issues.push({
        code: "loop.on_limit_not_exit",
        message: `Loop ${loop.id} onLimit must exit the loop region.`,
        loopId: loop.id,
        nodeId: loop.onLimitTarget,
      });
    }
  }
  for (const loop of graph.loops) {
    if (
      graph.nodes.has(loop.entry) &&
      !loopMembers.has(loop.id) &&
      !loopsInCyclicRegions.has(loop.id)
    ) {
      issues.push({
        code: "loop.not_cyclic",
        message: `Loop ${loop.id} does not describe a control-flow cycle.`,
        loopId: loop.id,
      });
    }
  }

  if (graph.nodes.has(graph.start)) {
    const reachableAdjacency = toAdjacency(graph.nodes, [...validEdges, ...onLimitEdges]);
    const reachable = new Set<string>();
    const pending = [graph.start];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      for (const target of reachableAdjacency.get(nodeId) ?? []) pending.push(target);
    }
    for (const nodeId of graph.nodes) {
      if (!reachable.has(nodeId)) {
        issues.push({
          code: "step.unreachable",
          message: `Flow step is unreachable from ${graph.start}: ${nodeId}`,
          nodeId,
        });
      }
    }
  }

  return { issues, loopMembers };
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((member) => right.has(member));
}

function intersectSets(sets: readonly ReadonlySet<string>[]): Set<string> {
  const [first, ...rest] = sets;
  if (first === undefined) return new Set();
  return new Set([...first].filter((value) => rest.every((set) => set.has(value))));
}

function toAdjacency(
  nodes: ReadonlySet<string>,
  edges: readonly ControlFlowEdge[],
): Map<string, Set<string>> {
  const adjacency = new Map([...nodes].map((node) => [node, new Set<string>()]));
  for (const edge of edges) adjacency.get(edge.source)?.add(edge.target);
  return adjacency;
}

function hasCycle(
  nodes: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of edges.get(node) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...nodes].some(visit);
}

function stronglyConnectedComponents(
  nodes: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string>[] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: ReadonlySet<string>[] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = new Set<string>();
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.add(current);
    } while (current !== node);
    result.push(component);
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return result;
}
