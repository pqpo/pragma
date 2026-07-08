import type { ExpertAgentRunContext } from "../runtime/run-context.ts";

export type ToolPolicyMode = "inherit" | "all" | "allow";

export interface ToolPolicy {
  readonly mode: ToolPolicyMode;
  readonly allowedTools?: readonly string[] | undefined;
  readonly deniedTools?: readonly string[] | undefined;
}

export interface ResolvedTool<TTool = unknown> {
  readonly name: string;
  readonly tool: TTool;
  readonly source: "default" | "managed" | "mcp";
}

export interface ResolvedToolSet<TTool = unknown> {
  readonly tools: readonly ResolvedTool<TTool>[];
  readonly policy: ToolPolicy;
}

export interface ToolPolicyResolverInput<TTool = unknown> {
  readonly tools: readonly ResolvedTool<TTool>[];
  readonly context?: ExpertAgentRunContext | undefined;
  readonly policy?: ToolPolicy | undefined;
}

export type ToolPolicyResolver<TTool = unknown> = (
  input: ToolPolicyResolverInput<TTool>,
) => ResolvedToolSet<TTool>;

export function resolveToolPolicy<TTool>(
  input: ToolPolicyResolverInput<TTool>,
): ResolvedToolSet<TTool> {
  const contextPolicy = readContextToolPolicy(input.context);
  const policy = mergeToolPolicy(contextPolicy, input.policy);
  const allowed = policy.allowedTools === undefined ? undefined : new Set(policy.allowedTools);
  const denied = new Set(policy.deniedTools ?? []);
  const names = new Set<string>();
  const tools: ResolvedTool<TTool>[] = [];

  for (const tool of input.tools) {
    if (names.has(tool.name)) {
      continue;
    }

    if (denied.has(tool.name)) {
      continue;
    }

    if (allowed !== undefined && !allowed.has(tool.name)) {
      continue;
    }

    names.add(tool.name);
    tools.push(tool);
  }

  return {
    tools,
    policy,
  };
}

export function selectResolvedTools<TTool>(
  parent: ResolvedToolSet<TTool>,
  policy: ToolPolicy,
): ResolvedToolSet<TTool> {
  return resolveToolPolicy({
    tools: parent.tools,
    policy,
  });
}

export function createToolPolicy(options: {
  readonly tools?: readonly string[] | "*" | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
}): ToolPolicy {
  if (options.tools === undefined) {
    return {
      mode: "inherit",
      deniedTools: options.disallowedTools,
    };
  }

  if (options.tools === "*") {
    return {
      mode: "all",
      deniedTools: options.disallowedTools,
    };
  }

  return {
    mode: "allow",
    allowedTools: options.tools,
    deniedTools: options.disallowedTools,
  };
}

function mergeToolPolicy(
  base: ToolPolicy | undefined,
  override: ToolPolicy | undefined,
): ToolPolicy {
  const mode = override?.mode ?? base?.mode ?? "all";
  const allowedTools = mergeAllowedTools(base?.allowedTools, override?.allowedTools);
  const deniedTools = mergeUnique(base?.deniedTools, override?.deniedTools);

  return {
    mode,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(deniedTools.length === 0 ? {} : { deniedTools }),
  };
}

function mergeAllowedTools(
  base: readonly string[] | undefined,
  override: readonly string[] | undefined,
): readonly string[] | undefined {
  if (base === undefined) {
    return override === undefined ? undefined : [...override];
  }

  if (override === undefined) {
    return [...base];
  }

  const overrideSet = new Set(override);
  return base.filter((tool) => overrideSet.has(tool));
}

function mergeUnique(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): readonly string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}

function readContextToolPolicy(context: ExpertAgentRunContext | undefined): ToolPolicy | undefined {
  const policy = context?.attributes?.["toolPolicy"];

  if (!isRecord(policy)) {
    return undefined;
  }

  return {
    mode:
      policy["mode"] === "inherit" || policy["mode"] === "allow" || policy["mode"] === "all"
        ? policy["mode"]
        : "all",
    ...(isStringArray(policy["allowedTools"]) ? { allowedTools: policy["allowedTools"] } : {}),
    ...(isStringArray(policy["deniedTools"]) ? { deniedTools: policy["deniedTools"] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
