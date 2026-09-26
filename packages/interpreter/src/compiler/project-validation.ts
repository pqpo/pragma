import { Validator, type Schema } from "@cfworker/json-schema";
import { PRAGMA_TEXT_LIMITS, pragmaUnicodeLength } from "@pragma/shared";
import { type PragmaDiagnostic, type PragmaFlowResource } from "../ast/pragma-dsl.schema.ts";
import { validatePragmaFlowDataContracts } from "../ast/flow-data-contracts.ts";
import { analyzePragmaFlowGraph } from "../ast/flow-graph.ts";
import { parsePragmaReference } from "../ast/resource-identity.ts";
import {
  ContextPolicyRegistry,
  FlowActionRegistry,
  ToolAdapterRegistry,
  type PragmaCompileHost,
} from "../runtime/registries.ts";
import { type IndexedResource, PragmaDslError } from "./project-contracts.ts";
import { z } from "zod";

export function createJsonSchemaZod(schema: unknown): z.ZodTypeAny | undefined {
  if (schema === undefined) return undefined;
  assertValidJsonSchema(schema);
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

export function validatePortableSemantics(
  indexed: IndexedResource,
  resources: ReadonlyMap<string, IndexedResource>,
): PragmaDiagnostic[] {
  const diagnostics: PragmaDiagnostic[] = [];
  const add = (code: string, message: string, path: (string | number)[]): void => {
    diagnostics.push({
      severity: "error",
      code,
      message,
      source: indexed.source,
      path,
    });
  };
  const warn = (code: string, message: string, path: (string | number)[]): void => {
    diagnostics.push({
      severity: "warning",
      code,
      message,
      source: indexed.source,
      path,
    });
  };
  const resource = indexed.resource;
  if (
    resource.kind === "ExpertTeam" &&
    resource.spec.instructions !== undefined &&
    pragmaUnicodeLength(resource.spec.instructions.trim()) >
      PRAGMA_TEXT_LIMITS.expertTeam.instructionsAuthoring
  ) {
    warn(
      "expert_team.instructions.authoring_limit",
      `ExpertTeam instructions exceed the ${PRAGMA_TEXT_LIMITS.expertTeam.instructionsAuthoring}-character authoring limit. Keep TEAM.md concise and move operational knowledge into Context documents. Existing pragma/v5 resources remain readable up to ${PRAGMA_TEXT_LIMITS.expertTeam.instructions} characters.`,
      ["spec", "instructions"],
    );
  }
  if (resource.kind === "Expert") {
    resource.spec.tools.forEach((binding, index) => {
      if (binding.adapter === "pragma.tool.call@v1") {
        if (
          binding.target === undefined ||
          binding.targets !== undefined ||
          binding.tool === undefined
        ) {
          add(
            "tool.binding.invalid",
            "pragma.tool.call@v1 requires exactly one target and a tool declaration.",
            ["spec", "tools", index],
          );
        }
        if (binding.policy !== undefined) {
          add(
            "tool.binding.invalid",
            "pragma.tool.call@v1 does not accept delegation policy fields.",
            ["spec", "tools", index, "policy"],
          );
        }
      }
      if (binding.adapter === "pragma.tool.delegate@v1") {
        if (binding.tool !== undefined) {
          add(
            "tool.binding.invalid",
            "pragma.tool.delegate@v1 does not accept a tool declaration.",
            ["spec", "tools", index, "tool"],
          );
        }
        const refs = binding.target === undefined ? (binding.targets ?? []) : [binding.target];
        for (const target of refs) {
          const parsed = parsePragmaReference(target.ref);
          const resolved = resources.get(`${parsed.kind}:${parsed.id}`)?.resource;
          if (resolved !== undefined && resolved.kind !== "Expert") {
            add("tool.binding.invalid", "pragma.tool.delegate@v1 only supports Expert targets.", [
              "spec",
              "tools",
              index,
            ]);
          }
        }
      }
    });
  }
  if (resource.kind === "Flow") {
    for (const [field, schema] of [
      ["input", resource.spec.input?.schema],
      ["output", resource.spec.output?.schema],
    ] as const) {
      if (schema === undefined) continue;
      try {
        assertValidJsonSchema(schema);
        new Validator(schema, "2020-12", false).validate(null);
      } catch (error) {
        add("flow.schema.invalid", error instanceof Error ? error.message : String(error), [
          "spec",
          field,
          "schema",
        ]);
      }
    }
  }
  if (resource.kind === "Automation") {
    const executorRef = resource.spec.route.executor.ref;
    const parsed = parsePragmaReference(executorRef);
    const executor = resources.get(`${parsed.kind}:${parsed.id}`)?.resource;
    if (executor?.kind === "Flow" && executor.spec.input?.schema !== undefined) {
      if (resource.spec.route.input.kind !== "flow") {
        add(
          "automation.input.kind_invalid",
          "Flows with an input schema require structured Automation input.",
          ["spec", "route", "input"],
        );
      } else {
        const flowInputSchema = createJsonSchemaZod(executor.spec.input.schema);
        if (flowInputSchema !== undefined) {
          const validation = flowInputSchema.safeParse(resource.spec.route.input.value);
          if (!validation.success) {
            for (const issue of validation.error.issues) {
              add("automation.input.schema_invalid", issue.message, [
                "spec",
                "route",
                "input",
                "value",
                ...issue.path.map((segment) =>
                  typeof segment === "symbol"
                    ? (segment.description ?? segment.toString())
                    : segment,
                ),
              ]);
            }
          }
        }
      }
    }
  }
  return diagnostics;
}

export function assertValidJsonSchema(
  value: unknown,
  path = "$",
  ancestors: Set<object> = new Set(),
): asserts value is Schema | boolean {
  if (typeof value === "boolean") return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`JSON Schema at ${path} must be an object or boolean.`);
  }
  if (ancestors.has(value)) throw new Error(`JSON Schema contains a cycle at ${path}.`);
  ancestors.add(value);
  try {
    const schema = value as Record<string, unknown>;
    const instanceTypes = new Set([
      "array",
      "boolean",
      "integer",
      "null",
      "number",
      "object",
      "string",
    ]);
    if (schema["type"] !== undefined) {
      const types = Array.isArray(schema["type"]) ? schema["type"] : [schema["type"]];
      if (
        types.length === 0 ||
        types.some((type) => typeof type !== "string" || !instanceTypes.has(type)) ||
        new Set(types).size !== types.length
      ) {
        throw new Error(`JSON Schema type is invalid at ${path}.type.`);
      }
    }
    for (const keyword of ["$id", "$anchor", "$ref", "$schema", "$comment", "format"] as const) {
      if (schema[keyword] !== undefined && typeof schema[keyword] !== "string") {
        throw new Error(`JSON Schema ${keyword} must be a string at ${path}.${keyword}.`);
      }
    }
    if (
      schema["enum"] !== undefined &&
      (!Array.isArray(schema["enum"]) || schema["enum"].length === 0)
    ) {
      throw new Error(`JSON Schema enum must be a non-empty array at ${path}.enum.`);
    }
    for (const keyword of ["required"] as const) {
      const entries = schema[keyword];
      if (
        entries !== undefined &&
        (!Array.isArray(entries) ||
          entries.some((entry) => typeof entry !== "string") ||
          new Set(entries).size !== entries.length)
      ) {
        throw new Error(
          `JSON Schema ${keyword} must contain unique strings at ${path}.${keyword}.`,
        );
      }
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
      const entries = schema[keyword];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error(`JSON Schema ${keyword} must be a non-empty array at ${path}.${keyword}.`);
      }
      entries.forEach((entry, index) =>
        assertValidJsonSchema(entry, `${path}.${keyword}[${index}]`, ancestors),
      );
    }
    for (const keyword of [
      "not",
      "if",
      "then",
      "else",
      "additionalProperties",
      "unevaluatedProperties",
      "propertyNames",
      "items",
      "additionalItems",
      "unevaluatedItems",
      "contains",
    ] as const) {
      const entry = schema[keyword];
      if (entry === undefined) continue;
      if (keyword === "items" && Array.isArray(entry)) {
        entry.forEach((item, index) =>
          assertValidJsonSchema(item, `${path}.items[${index}]`, ancestors),
        );
      } else {
        assertValidJsonSchema(entry, `${path}.${keyword}`, ancestors);
      }
    }
    for (const keyword of [
      "properties",
      "patternProperties",
      "$defs",
      "definitions",
      "dependentSchemas",
    ] as const) {
      const entries = schema[keyword];
      if (entries === undefined) continue;
      if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
        throw new Error(`JSON Schema ${keyword} must be an object at ${path}.${keyword}.`);
      }
      for (const [key, entry] of Object.entries(entries)) {
        assertValidJsonSchema(entry, `${path}.${keyword}.${key}`, ancestors);
      }
    }
    for (const keyword of [
      "minProperties",
      "maxProperties",
      "minItems",
      "maxItems",
      "minContains",
      "maxContains",
      "minLength",
      "maxLength",
    ] as const) {
      const entry = schema[keyword];
      if (entry !== undefined && (!Number.isSafeInteger(entry) || (entry as number) < 0)) {
        throw new Error(
          `JSON Schema ${keyword} must be a non-negative integer at ${path}.${keyword}.`,
        );
      }
    }
    for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
      const entry = schema[keyword];
      if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) {
        throw new Error(`JSON Schema ${keyword} must be finite at ${path}.${keyword}.`);
      }
    }
    if (
      schema["multipleOf"] !== undefined &&
      (typeof schema["multipleOf"] !== "number" ||
        !Number.isFinite(schema["multipleOf"]) ||
        schema["multipleOf"] <= 0)
    ) {
      throw new Error(`JSON Schema multipleOf must be positive at ${path}.multipleOf.`);
    }
    if (schema["pattern"] !== undefined) {
      if (typeof schema["pattern"] !== "string") {
        throw new Error(`JSON Schema pattern must be a string at ${path}.pattern.`);
      }
      try {
        new RegExp(schema["pattern"], "u");
      } catch {
        throw new Error(`JSON Schema pattern is invalid at ${path}.pattern.`);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

export function validateExtensionEnvironment(
  resources: ReadonlyMap<string, IndexedResource>,
  host: PragmaCompileHost,
): PragmaDiagnostic[] {
  const diagnostics: PragmaDiagnostic[] = [];
  const actions = host.actions ?? new FlowActionRegistry();
  const contextPolicies = host.contextPolicies ?? new ContextPolicyRegistry();
  const toolAdapters = host.toolAdapters ?? new ToolAdapterRegistry();
  const check = (
    indexed: IndexedResource,
    code: string,
    path: (string | number)[],
    run: () => void,
  ) => {
    try {
      run();
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code,
        message: error instanceof Error ? error.message : String(error),
        source: indexed.source,
        path,
      });
    }
  };
  for (const indexed of resources.values()) {
    const resource = indexed.resource;
    if (resource.kind === "Expert") {
      if (resource.spec.plugins.length > 0 && host.plugins === undefined) {
        diagnostics.push({
          severity: "error",
          code: "environment.plugin_resolver_unavailable",
          message: "The host does not provide a Plugin resolver.",
          source: indexed.source,
          path: ["spec", "plugins"],
        });
      }
      resource.spec.tools.forEach((binding, index) => {
        check(
          indexed,
          "environment.tool_adapter_unavailable",
          ["spec", "tools", index, "adapter"],
          () => {
            toolAdapters.resolve(binding.adapter);
          },
        );
      });
    } else if (resource.kind === "Flow") {
      Object.entries(resource.spec.graph.steps).forEach(([stepId, step]) => {
        if (step.action !== undefined) {
          check(
            indexed,
            "environment.flow_action_unavailable",
            ["spec", "graph", "steps", stepId, "action"],
            () => {
              actions.resolve(step.action!.ref);
            },
          );
        }
        if (step.context !== undefined) {
          check(
            indexed,
            "environment.context_policy_unavailable",
            ["spec", "graph", "steps", stepId, "context"],
            () => {
              contextPolicies.resolve(step.context!);
            },
          );
        }
      });
    }
  }
  return diagnostics;
}

export function validateFlowGraph(
  indexed: IndexedResource,
  resources: ReadonlyMap<string, IndexedResource>,
): PragmaDiagnostic[] {
  const resource = indexed.resource as PragmaFlowResource;
  return [
    ...analyzePragmaFlowGraph(resource).issues.map((issue) => ({
      severity: "error" as const,
      code: issue.code,
      message: issue.message,
      source: indexed.source,
      path: [...issue.path],
    })),
    ...invalidFlowExpressions(resource.spec).map((path) => ({
      severity: "error" as const,
      code: "flow.expression.invalid",
      message:
        "Use $flow.input, $node.output, $state paths, or {{ ... }} interpolation; ${...} is not supported.",
      source: indexed.source,
      path,
    })),
    ...validatePragmaFlowDataContracts(resource, {
      resolveResource: (ref) => resources.get(ref)?.resource,
    }).map((issue) => ({
      severity: "error" as const,
      code: issue.code,
      message: issue.message,
      source: indexed.source,
      path: [...issue.path],
    })),
  ];
}

function invalidFlowExpressions(
  value: unknown,
  path: (string | number)[] = ["spec"],
): (string | number)[][] {
  if (typeof value === "string") return value.includes("${") ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => invalidFlowExpressions(entry, [...path, index]));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    if (key === "prompt" && typeof entry === "object" && entry !== null && "segments" in entry) {
      return [];
    }
    return invalidFlowExpressions(entry, [...path, key]);
  });
}

export function validateAndReadLoopMembers(
  resource: PragmaFlowResource,
): Map<string, ReadonlySet<string>> {
  const analysis = analyzePragmaFlowGraph(resource);
  const issue = analysis.issues[0];
  if (issue !== undefined) throw new PragmaDslError(issue.message);
  return new Map(analysis.loopMembers);
}
