import type { PragmaFlowPrompt, PragmaFlowResource, PragmaResource } from "./pragma-dsl.schema.ts";
import type { PragmaJsonSchema } from "./tool-capability.schema.ts";
import { analyzePragmaFlowNodeAvailability } from "./flow-graph.ts";

export interface PragmaFlowDataContractIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly stepId?: string | undefined;
}

export interface PragmaFlowDataContractOptions {
  readonly resolveResource?: ((ref: string) => PragmaResource | undefined) | undefined;
}

interface ValueContext {
  readonly flow: PragmaFlowResource;
  readonly stageStepId?: string | undefined;
  readonly terminalStepId?: string | undefined;
  readonly add: (
    code: string,
    message: string,
    path: readonly (string | number)[],
    stepId?: string,
  ) => void;
  readonly resolveResource?: ((ref: string) => PragmaResource | undefined) | undefined;
}

interface ResolvedSource {
  readonly label: string;
  readonly schema?: PragmaJsonSchema | undefined;
  readonly guaranteed: boolean;
}

interface TerminalPath {
  readonly stepId: string;
  readonly path: readonly (string | number)[];
}

export function validatePragmaFlowDataContracts(
  flow: PragmaFlowResource,
  options: PragmaFlowDataContractOptions = {},
): readonly PragmaFlowDataContractIssue[] {
  const issues: PragmaFlowDataContractIssue[] = [];
  const seen = new Set<string>();
  const add = (
    code: string,
    message: string,
    path: readonly (string | number)[],
    stepId?: string,
  ): void => {
    const key = JSON.stringify([code, message, path, stepId]);
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ code, message, path, ...(stepId === undefined ? {} : { stepId }) });
  };

  for (const [stepId, step] of Object.entries(flow.spec.graph.steps)) {
    validatePrompt(flow, stepId, step.prompt, ["spec", "graph", "steps", stepId, "prompt"], add);
    validatePrompt(
      flow,
      stepId,
      step.human?.prompt,
      ["spec", "graph", "steps", stepId, "human", "prompt"],
      add,
    );
    validateRoute(flow, stepId, options.resolveResource, add);

    if (step.flow === undefined) continue;
    const target = options.resolveResource?.(step.flow.ref);
    if (target?.kind !== "Flow" || target.spec.input === undefined) continue;
    validateMappedValue(
      step.input ?? "$flow.input",
      target.spec.input.schema,
      ["spec", "graph", "steps", stepId, "input"],
      {
        flow,
        stageStepId: stepId,
        add,
        resolveResource: options.resolveResource,
      },
    );
  }

  const output = flow.spec.output;
  if (output === undefined) return issues;
  const terminals = terminalPaths(flow);
  if (output.value === undefined) {
    for (const terminal of terminals) {
      const source = stepOutputSchema(flow, terminal.stepId, options.resolveResource);
      if (source === undefined) {
        add(
          "flow.output.terminal_unvalidated",
          `Flow output cannot be verified for terminal node ${terminal.stepId}. Declare structured output for that node or configure an explicit Flow result mapping.`,
          terminal.path,
          terminal.stepId,
        );
        continue;
      }
      const incompatibility = schemaIncompatibility(source, output.schema);
      if (incompatibility !== undefined) {
        add(
          "flow.output.terminal_incompatible",
          `Terminal node ${terminal.stepId} cannot satisfy the Flow output contract: ${incompatibility}`,
          terminal.path,
          terminal.stepId,
        );
      }
    }
    return issues;
  }

  if (terminals.length === 0) {
    validateMappedValue(output.value, output.schema, ["spec", "output", "value"], {
      flow,
      add,
      resolveResource: options.resolveResource,
    });
    return issues;
  }
  for (const terminal of terminals) {
    validateMappedValue(output.value, output.schema, ["spec", "output", "value"], {
      flow,
      terminalStepId: terminal.stepId,
      add,
      resolveResource: options.resolveResource,
    });
  }
  return issues;
}

function validateRoute(
  flow: PragmaFlowResource,
  stepId: string,
  resolveResource: ((ref: string) => PragmaResource | undefined) | undefined,
  add: ValueContext["add"],
): void {
  const transition = flow.spec.graph.transitions[stepId];
  if (typeof transition !== "object" || !("route" in transition)) return;
  if (flow.spec.graph.steps[stepId]?.action !== undefined) return;
  const path = ["spec", "graph", "transitions", stepId] as const;
  const output = stepOutputSchema(flow, stepId, resolveResource);
  const field = output?.type === "object" ? output.properties[transition.route] : undefined;
  if ("branches" in transition) {
    if (field?.type !== "array" || field.items.type !== "string") {
      add(
        "flow.route.field_invalid",
        `Logic ${stepId}.result.${transition.route} must be a string array.`,
        path,
        stepId,
      );
    }
    if (transition.branches.length === 0) {
      add(
        "flow.route.branches_missing",
        `Logic ${stepId}.result.${transition.route} requires at least one branch.`,
        path,
        stepId,
      );
    }
    if (transition.fallback === undefined) {
      add(
        "flow.route.fallback_missing",
        `Logic ${stepId}.result.${transition.route} requires an otherwise branch.`,
        path,
        stepId,
      );
    }
    return;
  }
  if (field === undefined || !["string", "number", "integer", "boolean"].includes(field.type)) {
    add(
      "flow.route.field_invalid",
      `Node ${stepId} does not define routable output field ${transition.route}.`,
      path,
      stepId,
    );
  }
  if (Object.keys(transition.cases).some((key) => key.trim() === "")) {
    add("flow.route.case_invalid", "Logic branch values cannot be empty.", path, stepId);
  }
  if (field?.type === "boolean") {
    if (transition.cases["true"] === undefined || transition.cases["false"] === undefined) {
      add(
        "flow.route.boolean_incomplete",
        `Boolean logic ${stepId}.result.${transition.route} requires true and false branches.`,
        path,
        stepId,
      );
    }
    return;
  }
  if (field !== undefined && Object.keys(transition.cases).length === 0) {
    add(
      "flow.route.cases_missing",
      `Logic ${stepId}.result.${transition.route} requires at least one case.`,
      path,
      stepId,
    );
  }
  if (field !== undefined && transition.fallback === undefined) {
    add(
      "flow.route.fallback_missing",
      `Logic ${stepId}.result.${transition.route} requires an otherwise branch.`,
      path,
      stepId,
    );
  }
}

function validatePrompt(
  flow: PragmaFlowResource,
  stepId: string,
  prompt: PragmaFlowPrompt | undefined,
  path: readonly (string | number)[],
  add: ValueContext["add"],
): void {
  if (prompt === undefined) return;
  const availability = analyzePragmaFlowNodeAvailability(flow, stepId);
  prompt.segments.forEach((segment, index) => {
    if (!("variable" in segment)) return;
    const variable = segment.variable;
    const variablePath = [...path, "segments", index, "variable"];
    if (variable.source === "flow-input") {
      if (
        variable.path.length > 0 &&
        schemaAtPath(flow.spec.input?.schema, variable.path) === undefined
      ) {
        add(
          "flow.prompt.variable_path_invalid",
          `Flow input does not define structured field ${variable.path.join(".")}.`,
          variablePath,
          stepId,
        );
      }
      return;
    }
    const source = flow.spec.graph.steps[variable.nodeId];
    if (source === undefined) {
      add(
        "flow.prompt.variable_unknown",
        `Prompt variable references an unknown node: ${variable.nodeId}.`,
        variablePath,
        stepId,
      );
      return;
    }
    if (!availability.upstream.has(variable.nodeId)) {
      add(
        "flow.prompt.variable_not_upstream",
        `Prompt variable node cannot run before ${stepId}: ${variable.nodeId}.`,
        variablePath,
        stepId,
      );
    }
    if (
      variable.path.length > 0 &&
      schemaAtPath(stepOutputSchema(flow, variable.nodeId), variable.path) === undefined
    ) {
      add(
        "flow.prompt.variable_path_invalid",
        `Node ${variable.nodeId} does not define structured output field ${variable.path.join(".")}.`,
        variablePath,
        stepId,
      );
    }
  });
}

function validateMappedValue(
  value: unknown,
  expected: PragmaJsonSchema,
  path: readonly (string | number)[],
  context: ValueContext,
  allowUndefined = false,
): void {
  if (typeof value === "string") {
    const source = resolveExpression(value, context);
    if (source !== undefined) {
      if (!source.guaranteed && !allowUndefined) {
        context.add(
          "flow.contract.source_unavailable",
          `${source.label} is not available on every path to this stage.`,
          path,
          context.stageStepId ?? context.terminalStepId,
        );
        return;
      }
      if (source.schema === undefined) {
        context.add(
          "flow.contract.source_unvalidated",
          `${source.label} has no declared structured contract and cannot be assigned to a typed field.`,
          path,
          context.stageStepId ?? context.terminalStepId,
        );
        return;
      }
      const incompatibility = schemaIncompatibility(source.schema, expected);
      if (incompatibility !== undefined) {
        context.add(
          "flow.contract.type_mismatch",
          `${source.label} is incompatible with this field: ${incompatibility}`,
          path,
          context.stageStepId ?? context.terminalStepId,
        );
      }
      return;
    }
    if (containsInterpolation(value)) {
      validateInterpolations(value, path, context);
      if (expected.type !== "string") {
        addLiteralMismatch("interpolated string", expected, path, context);
      }
      return;
    }
    if (expected.type !== "string") addLiteralMismatch("string", expected, path, context);
    return;
  }

  if (expected.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      addLiteralMismatch(valueKind(value), expected, path, context);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (expected.properties[key] === undefined) {
        context.add(
          "flow.contract.property_unknown",
          `Field ${key} is not declared by the target contract.`,
          [...path, key],
          context.stageStepId ?? context.terminalStepId,
        );
      }
    }
    for (const required of expected.required ?? []) {
      if (!Object.hasOwn(record, required)) {
        context.add(
          "flow.contract.required_missing",
          `Required field ${required} is not mapped.`,
          [...path, required],
          context.stageStepId ?? context.terminalStepId,
        );
      }
    }
    for (const [key, child] of Object.entries(expected.properties)) {
      if (Object.hasOwn(record, key)) {
        validateMappedValue(
          record[key],
          child,
          [...path, key],
          context,
          !(expected.required ?? []).includes(key),
        );
      }
    }
    return;
  }

  if (expected.type === "array") {
    if (!Array.isArray(value)) {
      addLiteralMismatch(valueKind(value), expected, path, context);
      return;
    }
    value.forEach((entry, index) =>
      validateMappedValue(entry, expected.items, [...path, index], context),
    );
    return;
  }

  const compatible =
    expected.type === "boolean"
      ? typeof value === "boolean"
      : expected.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : expected.type === "integer"
          ? typeof value === "number" && Number.isInteger(value)
          : false;
  if (!compatible) addLiteralMismatch(valueKind(value), expected, path, context);
}

function resolveExpression(value: string, context: ValueContext): ResolvedSource | undefined {
  if (value === "$flow.input" || value.startsWith("$flow.input.")) {
    const path = value === "$flow.input" ? [] : value.slice("$flow.input.".length).split(".");
    const resolved = schemaAtPath(context.flow.spec.input?.schema, path);
    return {
      label: value,
      schema: resolved?.schema,
      guaranteed: path.length === 0 || resolved?.required === true,
    };
  }
  if (value === "$node.output" || value.startsWith("$node.output.")) {
    const terminalStepId = context.terminalStepId;
    if (terminalStepId === undefined) {
      return { label: value, guaranteed: false };
    }
    const path = value === "$node.output" ? [] : value.slice("$node.output.".length).split(".");
    const resolved = schemaAtPath(
      stepOutputSchema(context.flow, terminalStepId, context.resolveResource),
      path,
    );
    return {
      label: `${terminalStepId}.result${path.length === 0 ? "" : `.${path.join(".")}`}`,
      schema: resolved?.schema,
      guaranteed: path.length === 0 || resolved?.required === true,
    };
  }
  const stateMatch = /^\$state\.nodes\.([^.]+)\.result(?:\.(.+))?$/.exec(value);
  if (stateMatch === null) return undefined;
  const nodeId = stateMatch[1]!;
  const path = stateMatch[2]?.split(".") ?? [];
  const resolved = schemaAtPath(
    stepOutputSchema(context.flow, nodeId, context.resolveResource),
    path,
  );
  return {
    label: `${nodeId}.result${path.length === 0 ? "" : `.${path.join(".")}`}`,
    schema: resolved?.schema,
    guaranteed:
      nodeAvailableAtStage(context.flow, nodeId, context.stageStepId, context.terminalStepId) &&
      (path.length === 0 || resolved?.required === true),
  };
}

function nodeAvailableAtStage(
  flow: PragmaFlowResource,
  nodeId: string,
  stageStepId: string | undefined,
  terminalStepId: string | undefined,
): boolean {
  const target = stageStepId ?? terminalStepId;
  if (target === undefined || flow.spec.graph.steps[nodeId] === undefined) return false;
  if (terminalStepId !== undefined && nodeId === terminalStepId) return true;
  return analyzePragmaFlowNodeAvailability(flow, target).required.has(nodeId);
}

function validateInterpolations(
  value: string,
  path: readonly (string | number)[],
  context: ValueContext,
): void {
  for (const match of value.matchAll(/\{\{\s*([^}|]+?)(?:\|\s*json)?\s*\}\}/g)) {
    const expression = `$${match[1]!.trim().replace(/^\$/, "")}`;
    const source = resolveExpression(expression, context);
    if (source === undefined) continue;
    if (!source.guaranteed) {
      context.add(
        "flow.contract.source_unavailable",
        `${source.label} is not available on every path to this stage.`,
        path,
        context.stageStepId ?? context.terminalStepId,
      );
    } else if (source.schema === undefined) {
      context.add(
        "flow.contract.source_unvalidated",
        `${source.label} does not refer to a declared field.`,
        path,
        context.stageStepId ?? context.terminalStepId,
      );
    }
  }
}

function containsInterpolation(value: string): boolean {
  return /\{\{\s*[^}]+\s*\}\}/.test(value);
}

function schemaAtPath(
  schema: PragmaJsonSchema | undefined,
  path: readonly string[],
): { readonly schema: PragmaJsonSchema; readonly required: boolean } | undefined {
  if (schema === undefined) return undefined;
  let current = schema;
  let required = true;
  for (const segment of path) {
    if (current.type !== "object") return undefined;
    required &&= new Set(current.required ?? []).has(segment);
    const next = current.properties[segment];
    if (next === undefined) return undefined;
    current = next;
  }
  return { schema: current, required };
}

function stepOutputSchema(
  flow: PragmaFlowResource,
  stepId: string,
  resolveResource?: (ref: string) => PragmaResource | undefined,
): PragmaJsonSchema | undefined {
  const step = flow.spec.graph.steps[stepId];
  if (step === undefined) return undefined;
  if (step.human !== undefined) {
    return {
      type: "object",
      properties: {
        selection:
          step.human.selectionMode === "multiple"
            ? { type: "array", items: { type: "string" } }
            : { type: "string" },
      },
      required: ["selection"],
      additionalProperties: false,
    };
  }
  if (step.output !== undefined) return step.output.schema;
  if (step.flow !== undefined) {
    const target = resolveResource?.(step.flow.ref);
    if (target?.kind === "Flow") return target.spec.output?.schema;
  }
  return undefined;
}

function terminalPaths(flow: PragmaFlowResource): readonly TerminalPath[] {
  const terminals: TerminalPath[] = [];
  const addDestination = (
    stepId: string,
    destination: unknown,
    path: readonly (string | number)[],
  ): void => {
    if (
      typeof destination === "object" &&
      destination !== null &&
      "end" in destination &&
      (destination as { readonly end?: unknown }).end === true
    ) {
      terminals.push({ stepId, path });
    }
  };
  for (const [stepId, transition] of Object.entries(flow.spec.graph.transitions)) {
    const base = ["spec", "graph", "transitions", stepId] as const;
    if (typeof transition === "object" && "route" in transition) {
      if ("branches" in transition) {
        transition.branches.forEach((branch, index) =>
          addDestination(stepId, branch.destination, [...base, "branches", index, "destination"]),
        );
      } else {
        for (const [key, destination] of Object.entries(transition.cases)) {
          addDestination(stepId, destination, [...base, "cases", key]);
        }
      }
      if (transition.fallback !== undefined) {
        addDestination(stepId, transition.fallback, [...base, "fallback"]);
      }
    } else {
      addDestination(stepId, transition, base);
    }
  }
  for (const [loopId, loop] of Object.entries(flow.spec.graph.loops)) {
    if (loop.onLimit === undefined) continue;
    const repeatSources = Object.entries(flow.spec.graph.transitions)
      .filter(([, transition]) => transitionUsesLoop(transition, loopId))
      .map(([stepId]) => stepId);
    for (const stepId of repeatSources) {
      addDestination(stepId, loop.onLimit, ["spec", "graph", "loops", loopId, "onLimit"]);
    }
  }
  return terminals.filter(
    (terminal, index) =>
      terminals.findIndex(
        (candidate) =>
          candidate.stepId === terminal.stepId &&
          JSON.stringify(candidate.path) === JSON.stringify(terminal.path),
      ) === index,
  );
}

function transitionUsesLoop(
  transition: PragmaFlowResource["spec"]["graph"]["transitions"][string],
  loopId: string,
): boolean {
  const destinations =
    typeof transition === "object" && "route" in transition
      ? [
          ...("branches" in transition
            ? transition.branches.map((branch) => branch.destination)
            : Object.values(transition.cases)),
          ...(transition.fallback === undefined ? [] : [transition.fallback]),
        ]
      : [transition];
  return destinations.some(
    (destination) =>
      typeof destination === "object" &&
      "repeat" in destination &&
      destination.repeat.loop === loopId,
  );
}

function schemaIncompatibility(
  source: PragmaJsonSchema,
  target: PragmaJsonSchema,
  path = "result",
): string | undefined {
  if (source.type === "integer" && target.type === "number") return undefined;
  if (source.type !== target.type) {
    return `${path} is ${source.type}, but ${target.type} is required.`;
  }
  if (source.type === "array" && target.type === "array") {
    return schemaIncompatibility(source.items, target.items, `${path}[]`);
  }
  if (source.type !== "object" || target.type !== "object") return undefined;
  const sourceRequired = new Set(source.required ?? []);
  for (const required of target.required ?? []) {
    const child = source.properties[required];
    if (child === undefined) return `required field ${path}.${required} is missing.`;
    if (!sourceRequired.has(required)) {
      return `required field ${path}.${required} is optional in the source.`;
    }
    const childIssue = schemaIncompatibility(
      child,
      target.properties[required]!,
      `${path}.${required}`,
    );
    if (childIssue !== undefined) return childIssue;
  }
  for (const [name, child] of Object.entries(source.properties)) {
    const targetChild = target.properties[name];
    if (targetChild === undefined) {
      return `${path}.${name} is not allowed by the target contract.`;
    }
    const childIssue = schemaIncompatibility(child, targetChild, `${path}.${name}`);
    if (childIssue !== undefined) return childIssue;
  }
  return undefined;
}

function addLiteralMismatch(
  actual: string,
  expected: PragmaJsonSchema,
  path: readonly (string | number)[],
  context: ValueContext,
): void {
  context.add(
    "flow.contract.type_mismatch",
    `Expected ${expected.type}, but the mapped value is ${actual}.`,
    path,
    context.stageStepId ?? context.terminalStepId,
  );
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}
