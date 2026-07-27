import { isDeepStrictEqual } from "node:util";

import {
  resolveFlowRepeat,
  selectFlowTransition,
  type FlowDestination,
  type FlowLoopDefinition,
  type FlowStepReference,
  type FlowTerminal,
  type FlowTransition,
  type FlowTransitionSelection,
} from "@pragma/core";
import { z } from "zod";

import {
  PragmaFlowRunDrySuiteResultSchema,
  type PragmaFlowRunDryAssertion,
  type PragmaFlowRunDryCaseResult,
  type PragmaFlowRunDrySuiteResult,
} from "../ast/flow-run-dry.schema.ts";
import { analyzePragmaFlowGraph, type PragmaFlowGraphAnalysis } from "../ast/flow-graph.ts";
import {
  PragmaFlowResourceSchema,
  type PragmaFlowDestination,
  type PragmaFlowResource,
  type PragmaFlowRunDryCase,
  type PragmaFlowRunDryMockOutcome,
  type PragmaFlowTarget,
  type PragmaFlowTransition,
} from "../ast/pragma-dsl.schema.ts";
import { evaluatePragmaFlowValue, renderPragmaFlowPrompt } from "../runtime/flow-values.ts";

interface DryRunExecution {
  readonly path: string[];
  readonly coveredTransitions: Set<string>;
  readonly state: Record<string, unknown>;
  status: "succeeded" | "failed";
  output?: unknown;
  error?: string;
  configurationError?: string;
}

interface LoopState {
  iteration: number;
  status: "active" | "exited" | "exhausted";
}

class RunDryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunDryConfigurationError";
  }
}

export function runPragmaFlowDrySuite(rawFlow: PragmaFlowResource): PragmaFlowRunDrySuiteResult {
  const flow = PragmaFlowResourceSchema.parse(rawFlow);
  const graphAnalysis = analyzePragmaFlowGraph(flow);
  if (graphAnalysis.issues.length > 0) {
    throw new Error(`Flow graph is invalid: ${graphAnalysis.issues[0]!.message}`);
  }
  const cases = (flow.spec.runDry?.cases ?? []).map((testCase) =>
    runPragmaFlowDryCase(flow, testCase, graphAnalysis),
  );
  const required = listRequiredPragmaFlowDryTransitions(flow);
  const covered = [...new Set(cases.flatMap((result) => result.coveredTransitions))].toSorted();
  const coveredSet = new Set(covered);
  const missing = required.filter((transition) => !coveredSet.has(transition));
  const passedCases = cases.filter((result) => result.passed).length;
  return PragmaFlowRunDrySuiteResultSchema.parse({
    passed: cases.length > 0 && passedCases === cases.length && missing.length === 0,
    cases,
    coverage: {
      passed: missing.length === 0,
      covered,
      required,
      missing,
    },
    summary: {
      total: cases.length,
      passed: passedCases,
      failed: cases.length - passedCases,
    },
  });
}

export function listRequiredPragmaFlowDryTransitions(
  rawFlow: PragmaFlowResource,
): readonly string[] {
  const flow = PragmaFlowResourceSchema.parse(rawFlow);
  return [
    ...Object.entries(flow.spec.graph.transitions).flatMap(([stepId, transition]) =>
      transitionCoverageIds(stepId, transition),
    ),
    ...Object.entries(flow.spec.graph.loops).flatMap(([loopId, loop]) => [
      ...(loop.maxIterations > 1 ? [`loop:${loopId}:repeat`] : []),
      `loop:${loopId}:limit`,
    ]),
  ].toSorted();
}

function runPragmaFlowDryCase(
  flow: PragmaFlowResource,
  testCase: PragmaFlowRunDryCase,
  graphAnalysis: PragmaFlowGraphAnalysis,
): PragmaFlowRunDryCaseResult {
  const execution: DryRunExecution = {
    status: "failed",
    path: [],
    coveredTransitions: new Set(),
    state: Object.create(null) as Record<string, unknown>,
  };
  try {
    validateWithJsonSchema(flow.spec.input?.schema, testCase.input, "Flow input");
    executeCase(flow, testCase, execution, graphAnalysis);
  } catch (error) {
    execution.status = "failed";
    execution.error = error instanceof Error ? error.message : String(error);
    if (error instanceof RunDryConfigurationError) {
      execution.configurationError = execution.error;
    }
  }
  const assertions = assertExecution(testCase, execution);
  return PragmaFlowRunDrySuiteResultSchema.shape.cases.element.parse({
    id: testCase.id,
    name: testCase.name,
    passed: assertions.every((assertion) => assertion.passed),
    status: execution.status,
    path: execution.path,
    coveredTransitions: [...execution.coveredTransitions].toSorted(),
    assertions,
    ...(execution.output === undefined ? {} : { output: execution.output }),
    ...(execution.error === undefined ? {} : { error: execution.error }),
  });
}

function executeCase(
  flow: PragmaFlowResource,
  testCase: PragmaFlowRunDryCase,
  execution: DryRunExecution,
  graphAnalysis: PragmaFlowGraphAnalysis,
): void {
  const visits = new Map<string, number>();
  const loops = new Map<string, LoopState>();
  let stepId: string | undefined = flow.spec.graph.start;
  let terminalOutput: unknown;
  while (stepId !== undefined) {
    if (execution.path.length >= flow.spec.limits.maxNodeVisits) {
      throw new Error(
        `Flow ${flow.metadata.id} exceeded maxNodeVisits (${flow.spec.limits.maxNodeVisits}).`,
      );
    }
    for (const [loopId, loop] of Object.entries(flow.spec.graph.loops)) {
      if (loop.entry === stepId && loops.get(loopId)?.status !== "active") {
        loops.set(loopId, { iteration: 1, status: "active" });
      }
    }
    const step = flow.spec.graph.steps[stepId];
    if (step === undefined) throw new Error(`Flow step not found: ${stepId}`);
    execution.path.push(stepId);
    const visit = visits.get(stepId) ?? 0;
    visits.set(stepId, visit + 1);
    const outcome = readMockOutcome(testCase, stepId, visit);
    validateMockCall(step, outcome, execution.state, testCase.input, stepId, visit);
    if ("error" in outcome) throw new Error(outcome.error);
    validateStepOutput(step, outcome.output, stepId);
    writeCanonicalNodeResult(execution.state, stepId, outcome.output);
    const transition = flow.spec.graph.transitions[stepId];
    if (transition === undefined) throw new Error(`Flow step has no transition: ${stepId}`);
    const selection = selectFlowTransition(compileTransition(transition), outcome.output);
    if (selection === undefined) throw new Error(`Flow route has no matching target: ${stepId}`);
    execution.coveredTransitions.add(transitionCoverageId(stepId, selection));
    const target = applyLoopDestination(
      flow,
      stepId,
      selection.destination,
      loops,
      graphAnalysis.loopMembers,
      execution.coveredTransitions,
    );
    if ("id" in target) {
      stepId = target.id;
    } else if (target.type === "fail") {
      throw new Error(target.reason ?? `Flow ${flow.metadata.id} failed.`);
    } else {
      terminalOutput = outcome.output;
      stepId = undefined;
    }
  }
  const output =
    flow.spec.output?.value === undefined
      ? terminalOutput
      : evaluatePragmaFlowValue(
          flow.spec.output.value,
          execution.state,
          testCase.input,
          terminalOutput,
        );
  validateWithJsonSchema(flow.spec.output?.schema, output, "Flow output");
  execution.status = "succeeded";
  execution.output = output;
}

function readMockOutcome(
  testCase: PragmaFlowRunDryCase,
  stepId: string,
  visit: number,
): PragmaFlowRunDryMockOutcome {
  const configured = testCase.mocks[stepId];
  if (configured === undefined) {
    throw new RunDryConfigurationError(
      `Run dry mock is missing for step ${stepId} visit ${visit + 1}.`,
    );
  }
  const sequence = Array.isArray(configured) ? configured : [configured];
  const outcome = sequence[visit];
  if (outcome === undefined) {
    throw new RunDryConfigurationError(
      `Run dry mock is missing for step ${stepId} visit ${visit + 1}.`,
    );
  }
  return outcome;
}

function validateMockCall(
  step: PragmaFlowResource["spec"]["graph"]["steps"][string],
  outcome: PragmaFlowRunDryMockOutcome,
  state: Record<string, unknown>,
  flowInput: unknown,
  stepId: string,
  visit: number,
): void {
  const input =
    step.expert !== undefined || step.team !== undefined
      ? step.prompt === undefined
        ? flowInput
        : renderPragmaFlowPrompt(step.prompt, state, flowInput)
      : step.input === undefined
        ? flowInput
        : evaluatePragmaFlowValue(step.input, state, flowInput);
  if (!isDeepStrictEqual(input, outcome.expectInput)) {
    throw new RunDryConfigurationError(
      `Run dry mock input does not match step ${stepId} visit ${visit + 1}.`,
    );
  }
  if (step.human === undefined) {
    if (outcome.expectPrompt !== undefined) {
      throw new RunDryConfigurationError(
        `Only a Human Task mock can declare expectPrompt: ${stepId} visit ${visit + 1}.`,
      );
    }
    return;
  }
  if (outcome.expectPrompt === undefined) {
    throw new RunDryConfigurationError(
      `Human step ${stepId} mock must declare expectPrompt for visit ${visit + 1}.`,
    );
  }
  const prompt = renderPragmaFlowPrompt(step.human.prompt, state, input);
  if (prompt !== outcome.expectPrompt) {
    throw new RunDryConfigurationError(
      `Run dry mock prompt does not match Human step ${stepId} visit ${visit + 1}.`,
    );
  }
}

function validateStepOutput(
  step: PragmaFlowResource["spec"]["graph"]["steps"][string],
  output: unknown,
  stepId: string,
): void {
  if (step.output !== undefined) {
    validateWithJsonSchema(step.output.schema, output, `Flow step ${stepId} output`);
  }
  if (step.human === undefined) return;
  if (
    typeof output !== "object" ||
    output === null ||
    Array.isArray(output) ||
    !("selection" in output)
  ) {
    throw new Error(`Human step ${stepId} mock must return a selection.`);
  }
  const selection = (output as { readonly selection: unknown }).selection;
  const values = new Set(step.human.options.map((option) => option.value));
  if (step.human.selectionMode === "single") {
    if (typeof selection !== "string" || !values.has(selection)) {
      throw new Error(`Human step ${stepId} mock selected an unknown option.`);
    }
    return;
  }
  if (
    !Array.isArray(selection) ||
    selection.length === 0 ||
    selection.some((value) => typeof value !== "string" || !values.has(value))
  ) {
    throw new Error(`Human step ${stepId} mock must select one or more known options.`);
  }
}

function applyLoopDestination(
  flow: PragmaFlowResource,
  sourceStepId: string,
  destination: FlowDestination,
  loops: Map<string, LoopState>,
  loopMembers: ReadonlyMap<string, ReadonlySet<string>>,
  coveredTransitions: Set<string>,
): FlowStepReference | FlowTerminal {
  let target: FlowStepReference | FlowTerminal;
  if ("type" in destination && destination.type === "repeat") {
    const declared = flow.spec.graph.loops[destination.loopId];
    if (declared === undefined) {
      throw new Error(`Flow repeat references unknown loop: ${destination.loopId}`);
    }
    const loop: FlowLoopDefinition = {
      id: destination.loopId,
      entryStepId: declared.entry,
      stepIds: loopMembers.get(destination.loopId) ?? new Set(),
      maxIterations: declared.maxIterations,
      onLimit: declared.onLimit === undefined ? undefined : compileTarget(declared.onLimit),
    };
    const current = loops.get(destination.loopId) ?? { iteration: 1, status: "active" };
    const resolution = resolveFlowRepeat(destination, loop, current.iteration);
    coveredTransitions.add(`loop:${destination.loopId}:${resolution.kind}`);
    if (resolution.kind === "limit") {
      loops.set(destination.loopId, { ...current, status: "exhausted" });
    } else {
      loops.set(destination.loopId, {
        iteration: resolution.iteration,
        status: "active",
      });
    }
    target = resolution.target;
  } else {
    target = destination;
  }
  const targetStepId = "id" in target ? target.id : undefined;
  for (const [loopId, state] of loops) {
    if (state.status !== "active") continue;
    const members = loopMembers.get(loopId);
    if (members?.has(sourceStepId) !== true) continue;
    if (targetStepId !== undefined && members.has(targetStepId)) continue;
    loops.set(loopId, { ...state, status: "exited" });
  }
  return target;
}

function assertExecution(
  testCase: PragmaFlowRunDryCase,
  execution: DryRunExecution,
): readonly PragmaFlowRunDryAssertion[] {
  const assertions: PragmaFlowRunDryAssertion[] = [
    {
      kind: "status",
      passed: execution.status === testCase.expect.status,
      message: `Expected status ${testCase.expect.status}, received ${execution.status}.`,
    },
    {
      kind: "path",
      passed: isDeepStrictEqual(execution.path, testCase.expect.path),
      message: `Expected path ${JSON.stringify(testCase.expect.path)}, received ${JSON.stringify(execution.path)}.`,
    },
  ];
  if (testCase.expect.output !== undefined) {
    assertions.push({
      kind: "output",
      passed: isDeepStrictEqual(execution.output, testCase.expect.output),
      message: "Expected output does not match the run dry output.",
    });
  }
  if (testCase.expect.errorContains !== undefined) {
    assertions.push({
      kind: "error",
      passed: execution.error?.includes(testCase.expect.errorContains) === true,
      message: `Expected error to contain ${JSON.stringify(testCase.expect.errorContains)}.`,
    });
  }
  if (execution.configurationError !== undefined) {
    assertions.push({
      kind: "configuration",
      passed: false,
      message: execution.configurationError,
    });
  }
  return assertions;
}

function compileTransition(transition: PragmaFlowTransition): FlowTransition {
  if (!isRouteTransition(transition)) {
    const destination = compileDestination(transition);
    return "type" in destination && destination.type === "repeat"
      ? destination
      : { type: "next", target: destination };
  }
  if ("branches" in transition) {
    return {
      type: "array-route",
      field: transition.route,
      branches: transition.branches.map((branch) => ({
        id: branch.id,
        operator: branch.operator,
        values: branch.values,
        destination: compileDestination(branch.destination),
      })),
      fallback:
        transition.fallback === undefined ? undefined : compileDestination(transition.fallback),
    };
  }
  return {
    type: "route",
    field: transition.route,
    cases: new Map(
      Object.entries(transition.cases).map(([key, destination]) => [
        key,
        compileDestination(destination),
      ]),
    ),
    fallback:
      transition.fallback === undefined ? undefined : compileDestination(transition.fallback),
  };
}

function compileDestination(destination: PragmaFlowDestination): FlowDestination {
  if (typeof destination === "object" && "repeat" in destination) {
    return {
      type: "repeat",
      loopId: destination.repeat.loop,
      target: { id: destination.repeat.goto },
    };
  }
  return compileTarget(destination);
}

function compileTarget(target: PragmaFlowTarget): FlowStepReference | FlowTerminal {
  if (typeof target === "string") return { id: target };
  if ("goto" in target) return { id: target.goto };
  if ("end" in target) return { type: "end" };
  return { type: "fail", reason: target.fail };
}

function transitionCoverageId(stepId: string, selection: FlowTransitionSelection): string {
  if (selection.kind === "case") return `${stepId}:case:${selection.caseKey}`;
  if (selection.kind === "branch") return `${stepId}:branch:${selection.branchId}`;
  if (selection.kind === "fallback") return `${stepId}:fallback`;
  return `${stepId}:next`;
}

function transitionCoverageIds(
  stepId: string,
  transition: PragmaFlowTransition,
): readonly string[] {
  if (!isRouteTransition(transition)) return [`${stepId}:next`];
  if ("branches" in transition) {
    return [
      ...transition.branches.map((branch) => `${stepId}:branch:${branch.id}`),
      ...(transition.fallback === undefined ? [] : [`${stepId}:fallback`]),
    ];
  }
  return [
    ...Object.keys(transition.cases).map((key) => `${stepId}:case:${key}`),
    ...(transition.fallback === undefined ? [] : [`${stepId}:fallback`]),
  ];
}

function isRouteTransition(
  transition: PragmaFlowTransition,
): transition is Extract<PragmaFlowTransition, { readonly route: string }> {
  return typeof transition === "object" && "route" in transition;
}

function writeCanonicalNodeResult(
  state: Record<string, unknown>,
  nodeId: string,
  output: unknown,
): void {
  const existingNodes = state["nodes"];
  const nodes =
    typeof existingNodes === "object" && existingNodes !== null && !Array.isArray(existingNodes)
      ? (existingNodes as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
  const existingNode = nodes[nodeId];
  const node =
    typeof existingNode === "object" && existingNode !== null && !Array.isArray(existingNode)
      ? (existingNode as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
  node["result"] = output;
  nodes[nodeId] = node;
  state["nodes"] = nodes;
}

function validateWithJsonSchema(schema: unknown, value: unknown, label: string): void {
  if (schema === undefined) return;
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    throw new RunDryConfigurationError(
      `${label} schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = validator.safeParse(value);
  if (parsed.success) return;
  throw new Error(`${label} is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
}
