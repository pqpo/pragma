import type { PragmaFlowPrompt } from "../ast/pragma-dsl.schema.ts";

const UNSAFE_STATE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function evaluatePragmaFlowValue(
  value: unknown,
  state: Readonly<Record<string, unknown>>,
  flowInput: unknown,
  nodeOutput?: unknown,
): unknown {
  if (typeof value === "string") {
    if (value === "$flow.input") return flowInput;
    if (value.startsWith("$flow.input.")) {
      return readPragmaFlowPath(flowInput, value.slice("$flow.input.".length));
    }
    if (value === "$node.output") return nodeOutput;
    if (value.startsWith("$node.output.")) {
      return readPragmaFlowPath(nodeOutput, value.slice("$node.output.".length));
    }
    if (value.startsWith("$state.")) {
      return readPragmaFlowPath(state, value.slice("$state.".length));
    }
    return value.replace(/\{\{\s*([^}|]+?)\s*(\|\s*json)?\s*\}\}/g, (_match, expression, json) => {
      const resolved = evaluatePragmaFlowValue(
        `$${String(expression).trim().replace(/^\$/, "")}`,
        state,
        flowInput,
        nodeOutput,
      );
      return json === undefined ? String(resolved ?? "") : JSON.stringify(resolved, null, 2);
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => evaluatePragmaFlowValue(entry, state, flowInput, nodeOutput));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        evaluatePragmaFlowValue(entry, state, flowInput, nodeOutput),
      ]),
    );
  }
  return value;
}

export function renderPragmaFlowPrompt(
  prompt: PragmaFlowPrompt,
  state: Readonly<Record<string, unknown>>,
  flowInput: unknown,
): string {
  return prompt.segments
    .map((segment) => {
      if ("text" in segment) return segment.text;
      const variable = segment.variable;
      const value =
        variable.source === "flow-input"
          ? readPragmaFlowPathSegments(flowInput, variable.path)
          : readPragmaFlowPathSegments(state, [
              "nodes",
              variable.nodeId,
              "result",
              ...variable.path,
            ]);
      if (value === undefined || value === null) return "null";
      if (typeof value === "string") return value;
      return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    })
    .join("");
}

function readPragmaFlowPath(value: unknown, path: string): unknown {
  return readPragmaFlowPathSegments(value, path.split("."));
}

function readPragmaFlowPathSegments(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, segment) => {
    if (UNSAFE_STATE_SEGMENTS.has(segment)) return undefined;
    if (typeof current !== "object" || current === null) return undefined;
    return Object.hasOwn(current, segment)
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }, value);
}
