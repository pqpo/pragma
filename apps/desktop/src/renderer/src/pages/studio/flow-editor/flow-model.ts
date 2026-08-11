import {
  analyzePragmaFlowGraph,
  canonicalPragmaResourceRef,
  PragmaFlowResourceSchema,
  validatePragmaFlowDataContracts,
  type PragmaFlowDestination,
  type PragmaFlowResource,
  type PragmaFlowTransition,
  type PragmaResource,
} from "@pragma/interpreter/ast";

export type FlowStep = PragmaFlowResource["spec"]["graph"]["steps"][string];
export const FLOW_STEP_KINDS = ["action", "expert", "team", "flow", "human"] as const;
export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];
export type TransitionMode = "goto" | "end" | "fail" | "repeat" | "route";

export function isFlowStepKind(value: string): value is FlowStepKind {
  return (FLOW_STEP_KINDS as readonly string[]).includes(value);
}

export interface FlowValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly stepId?: string | undefined;
}

export function createEmptyFlow(id = "0000000000000000"): PragmaFlowResource {
  return {
    apiVersion: "pragma/v4",
    kind: "Flow",
    metadata: {
      id,
      name: "Untitled flow",
      description: "Describe what this flow orchestrates.",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 1_000 },
      graph: {
        start: "",
        steps: {},
        loops: {},
        transitions: {},
      },
    },
  };
}

export function flowStepKind(step: FlowStep): FlowStepKind {
  if (step.action !== undefined) return "action";
  if (step.expert !== undefined) return "expert";
  if (step.team !== undefined) return "team";
  if (step.flow !== undefined) return "flow";
  return "human";
}

export function flowStepTarget(step: FlowStep): string {
  return (
    step.action?.ref ??
    step.expert?.ref ??
    step.team?.ref ??
    step.flow?.ref ??
    step.human?.selectionMode ??
    ""
  );
}

export function transitionMode(transition: PragmaFlowTransition): TransitionMode {
  if (typeof transition === "object" && "route" in transition) return "route";
  const destination = transition as PragmaFlowDestination;
  if (typeof destination === "string" || "goto" in destination) return "goto";
  if ("end" in destination) return "end";
  if ("fail" in destination) return "fail";
  return "repeat";
}

export function destinationTarget(destination: PragmaFlowDestination): string | null {
  if (typeof destination === "string") return destination;
  if ("goto" in destination) return destination.goto;
  if ("repeat" in destination) return destination.repeat.goto;
  return null;
}

export function renameFlowStep(
  flow: PragmaFlowResource,
  previousId: string,
  nextId: string,
): PragmaFlowResource {
  if (previousId === nextId) return flow;
  const copy = structuredClone(flow);
  const step = copy.spec.graph.steps[previousId];
  if (step === undefined || nextId.trim() === "" || copy.spec.graph.steps[nextId] !== undefined) {
    return flow;
  }
  delete copy.spec.graph.steps[previousId];
  copy.spec.graph.steps[nextId] = step;
  const transition = copy.spec.graph.transitions[previousId];
  delete copy.spec.graph.transitions[previousId];
  if (transition !== undefined) copy.spec.graph.transitions[nextId] = transition;
  if (copy.spec.graph.start === previousId) copy.spec.graph.start = nextId;
  for (const [source, current] of Object.entries(copy.spec.graph.transitions)) {
    copy.spec.graph.transitions[source] = mapTransitionTargets(current, previousId, nextId);
  }
  for (const loop of Object.values(copy.spec.graph.loops)) {
    if (loop.entry === previousId) loop.entry = nextId;
    if (loop.onLimit !== undefined)
      loop.onLimit = mapDestinationTarget(loop.onLimit, previousId, nextId) as typeof loop.onLimit;
  }
  for (const current of Object.values(copy.spec.graph.steps)) {
    if (current.prompt !== undefined) {
      current.prompt.segments = renamePromptNode(current.prompt.segments, previousId, nextId);
    }
    if (current.human !== undefined) {
      current.human.prompt.segments = renamePromptNode(
        current.human.prompt.segments,
        previousId,
        nextId,
      );
    }
    if (current.input !== undefined) {
      current.input = renameMappedNode(current.input, previousId, nextId);
    }
  }
  if (copy.spec.output?.value !== undefined) {
    copy.spec.output.value = renameMappedNode(copy.spec.output.value, previousId, nextId);
  }
  return copy;
}

export function deleteFlowStep(flow: PragmaFlowResource, stepId: string): PragmaFlowResource {
  const copy = structuredClone(flow);
  if (copy.spec.graph.steps[stepId] === undefined) return flow;
  delete copy.spec.graph.steps[stepId];
  delete copy.spec.graph.transitions[stepId];
  if (copy.spec.graph.start === stepId) copy.spec.graph.start = "";
  for (const [source, transition] of Object.entries(copy.spec.graph.transitions)) {
    const next = removeDeletedTarget(transition, stepId);
    if (next === undefined) delete copy.spec.graph.transitions[source];
    else copy.spec.graph.transitions[source] = next;
  }
  for (const [loopId, loop] of Object.entries(copy.spec.graph.loops)) {
    if (loop.entry === stepId) {
      delete copy.spec.graph.loops[loopId];
      continue;
    }
    if (loop.onLimit !== undefined && destinationTarget(loop.onLimit) === stepId) {
      delete loop.onLimit;
    }
  }
  for (const current of Object.values(copy.spec.graph.steps)) {
    if (current.prompt !== undefined) {
      current.prompt.segments = removePromptNode(current.prompt.segments, stepId);
    }
    if (current.human !== undefined) {
      current.human.prompt.segments = removePromptNode(current.human.prompt.segments, stepId);
    }
    if (current.input !== undefined) current.input = removeMappedNode(current.input, stepId);
  }
  if (copy.spec.output?.value !== undefined) {
    copy.spec.output.value = removeMappedNode(copy.spec.output.value, stepId);
  }
  const referencedLoopIds = transitionLoopIds(Object.values(copy.spec.graph.transitions));
  for (const loopId of Object.keys(copy.spec.graph.loops)) {
    if (!referencedLoopIds.has(loopId)) delete copy.spec.graph.loops[loopId];
  }
  return copy;
}

function renamePromptNode(
  segments: NonNullable<FlowStep["prompt"]>["segments"],
  previousId: string,
  nextId: string,
) {
  return segments.map((segment) =>
    "variable" in segment &&
    segment.variable.source === "node-output" &&
    segment.variable.nodeId === previousId
      ? { variable: { ...segment.variable, nodeId: nextId } }
      : segment,
  );
}

function removePromptNode(segments: NonNullable<FlowStep["prompt"]>["segments"], nodeId: string) {
  return segments.filter(
    (segment) =>
      !(
        "variable" in segment &&
        segment.variable.source === "node-output" &&
        segment.variable.nodeId === nodeId
      ),
  );
}

function renameMappedNode(value: unknown, previousId: string, nextId: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(`$state.nodes.${previousId}.result`, `$state.nodes.${nextId}.result`);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renameMappedNode(entry, previousId, nextId));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        renameMappedNode(entry, previousId, nextId),
      ]),
    );
  }
  return value;
}

function removeMappedNode(value: unknown, nodeId: string): unknown {
  if (typeof value === "string") {
    return value.includes(`$state.nodes.${nodeId}.result`) ? null : value;
  }
  if (Array.isArray(value)) return value.map((entry) => removeMappedNode(entry, nodeId));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, removeMappedNode(entry, nodeId)]),
    );
  }
  return value;
}

export function validateFlowDraft(
  flow: PragmaFlowResource,
  resources: readonly PragmaResource[] = [],
): readonly FlowValidationIssue[] {
  const stepIds = new Set(Object.keys(flow.spec.graph.steps));
  const emptyGraph = stepIds.size === 0;
  const parsed = PragmaFlowResourceSchema.safeParse(flow);
  const issues: FlowValidationIssue[] = parsed.success
    ? []
    : parsed.error.issues
        .filter(
          (issue) =>
            !(
              emptyGraph &&
              issue.path.length === 3 &&
              issue.path[0] === "spec" &&
              issue.path[1] === "graph" &&
              issue.path[2] === "start"
            ),
        )
        .map((issue) => ({
          path: issue.path.filter(
            (segment): segment is string | number => typeof segment !== "symbol",
          ),
          message: friendlyIssueMessage(issue.path, issue.message),
          stepId: stepIdFromPath(issue.path),
        }));
  if (emptyGraph) {
    issues.push({ path: ["spec", "graph", "steps"], message: "Add at least one node." });
  } else {
    for (const issue of analyzePragmaFlowGraph(flow).issues) {
      issues.push({
        path: issue.path,
        message: issue.message,
        stepId: issue.stepId,
      });
    }
  }
  for (const [stepId, step] of Object.entries(flow.spec.graph.steps)) {
    if (step.action !== undefined) {
      issues.push({
        path: ["spec", "graph", "steps", stepId, "action"],
        message: "Action steps are not executable in the current Desktop environment.",
        stepId,
      });
    }
  }
  const resourcesByRef = new Map(
    resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  issues.push(
    ...validatePragmaFlowDataContracts(flow, {
      resolveResource: (ref) => resourcesByRef.get(ref),
    }).map((issue) => ({
      path: issue.path,
      message: issue.message,
      ...(issue.stepId === undefined ? {} : { stepId: issue.stepId }),
    })),
  );
  return issues;
}

function mapTransitionTargets(
  transition: PragmaFlowTransition,
  previousId: string,
  nextId: string,
): PragmaFlowTransition {
  if (typeof transition === "object" && "route" in transition) {
    if ("branches" in transition) {
      return {
        ...transition,
        branches: transition.branches.map((branch) => ({
          ...branch,
          destination: mapDestinationTarget(branch.destination, previousId, nextId),
        })),
        ...(transition.fallback === undefined
          ? {}
          : { fallback: mapDestinationTarget(transition.fallback, previousId, nextId) }),
      };
    }
    return {
      ...transition,
      cases: Object.fromEntries(
        Object.entries(transition.cases).map(([key, destination]) => [
          key,
          mapDestinationTarget(destination, previousId, nextId),
        ]),
      ),
      ...(transition.fallback === undefined
        ? {}
        : { fallback: mapDestinationTarget(transition.fallback, previousId, nextId) }),
    };
  }
  return mapDestinationTarget(transition, previousId, nextId);
}

function mapDestinationTarget(
  destination: PragmaFlowDestination,
  previousId: string,
  nextId: string,
): PragmaFlowDestination {
  if (typeof destination === "string") {
    return destination === previousId ? nextId : destination;
  }
  if ("goto" in destination) {
    return {
      ...destination,
      goto: destination.goto === previousId ? nextId : destination.goto,
    };
  }
  if ("repeat" in destination) {
    return {
      repeat: {
        ...destination.repeat,
        goto: destination.repeat.goto === previousId ? nextId : destination.repeat.goto,
      },
    };
  }
  return destination;
}

function removeDeletedTarget(
  transition: PragmaFlowTransition,
  deletedId: string,
): PragmaFlowTransition | undefined {
  if (typeof transition === "object" && "route" in transition) {
    if ("branches" in transition) {
      return {
        ...transition,
        branches: transition.branches.map((branch) => ({
          ...branch,
          destination:
            destinationTarget(branch.destination) === deletedId ? { goto: "" } : branch.destination,
        })),
        ...(transition.fallback !== undefined &&
        destinationTarget(transition.fallback) === deletedId
          ? { fallback: { goto: "" } }
          : {}),
      };
    }
    const cases = Object.fromEntries(
      Object.entries(transition.cases).map(([key, destination]) => [
        key,
        destinationTarget(destination) === deletedId ? { goto: "" } : destination,
      ]),
    );
    return {
      ...transition,
      cases,
      ...(transition.fallback !== undefined && destinationTarget(transition.fallback) === deletedId
        ? { fallback: { goto: "" } }
        : {}),
    };
  }
  return destinationTarget(transition) === deletedId ? undefined : transition;
}

function transitionLoopIds(transitions: readonly PragmaFlowTransition[]): ReadonlySet<string> {
  const loopIds = new Set<string>();
  for (const transition of transitions) {
    const destinations =
      typeof transition === "object" && "route" in transition
        ? [
            ...("branches" in transition
              ? transition.branches.map((branch) => branch.destination)
              : Object.values(transition.cases)),
            transition.fallback,
          ].filter((destination): destination is PragmaFlowDestination => destination !== undefined)
        : [transition];
    for (const destination of destinations) {
      if (typeof destination === "object" && "repeat" in destination) {
        loopIds.add(destination.repeat.loop);
      }
    }
  }
  return loopIds;
}

function stepIdFromPath(path: readonly PropertyKey[]): string | undefined {
  const stepsIndex = path.indexOf("steps");
  const candidate = path[stepsIndex + 1];
  return stepsIndex >= 0 && typeof candidate === "string" ? candidate : undefined;
}

function friendlyIssueMessage(path: readonly PropertyKey[], fallback: string): string {
  if (path.length === 2 && path[0] === "metadata" && path[1] === "id") {
    return "Resource ID must be a 16-character lowercase Crockford Base32 ID.";
  }
  if (path.length === 2 && path[0] === "metadata" && path[1] === "name") {
    return "Flow name is required.";
  }
  if (path.length === 2 && path[0] === "metadata" && path[1] === "description") {
    return "Flow description is required.";
  }
  return fallback;
}
