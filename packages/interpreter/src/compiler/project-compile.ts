import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  defineExpert,
  defineFlow,
  mergeExpertAgentToolApprovals,
  sanitizeExecutionToolName,
  type Expert,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type ExpertDefinition,
  type Flow,
  type FlowState,
  type FlowStepReference,
  type FlowTerminal,
  type IExpertAgentMcpConfig,
  type IExpertAgentSkillsConfig,
} from "@pragma/core";
import { z } from "zod";
import {
  type PragmaExpertResource,
  type PragmaFlowDestination,
  type PragmaFlowResource,
  type PragmaFlowTarget,
  type PragmaFlowTransition,
} from "../ast/pragma-dsl.schema.ts";
import {
  ContextPolicyRegistry,
  FlowActionRegistry,
  type InvocableResource,
  type PragmaCompileHost,
  type PragmaPluginResolution,
} from "../runtime/registries.ts";
import {
  createContextSystem,
  type PragmaCapabilityContribution,
  type PragmaContextStoreContribution,
  type PragmaRuntimeProfileContribution,
} from "../runtime/resource-adapters.ts";
import { evaluatePragmaFlowValue, renderPragmaFlowPrompt } from "../runtime/flow-values.ts";
import { PragmaDslError } from "./project-contracts.ts";
import { createJsonSchemaZod, validateAndReadLoopMembers } from "./project-validation.ts";
import { requireStepReference } from "./project-dependencies.ts";

export async function compileExpert(
  resource: PragmaExpertResource,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
  host: PragmaCompileHost,
  executionOverride:
    | {
        readonly runtimeId: string;
        readonly modelSelection?: import("@pragma/core").RuntimeModelSelection | undefined;
      }
    | undefined,
  resolvers: {
    readonly resolveCapability: (ref: string) => Promise<PragmaCapabilityContribution>;
    readonly resolveContextStore: (ref: string) => Promise<PragmaContextStoreContribution>;
    readonly resolveRuntime: (ref: string) => Promise<PragmaRuntimeProfileContribution>;
    readonly resolvePlugin: (
      binding: PragmaExpertResource["spec"]["plugins"][number],
    ) => Promise<PragmaPluginResolution>;
  },
): Promise<Expert> {
  const [plugins, runtime, capabilities, contextStores] = await Promise.all([
    Promise.all(resource.spec.plugins.map(resolvers.resolvePlugin)),
    executionOverride !== undefined || resource.spec.runtime === undefined
      ? Promise.resolve(undefined)
      : resolvers.resolveRuntime(resource.spec.runtime.ref),
    Promise.all(
      resource.spec.capabilities.map(async (binding) => ({
        binding,
        contribution: await resolvers.resolveCapability(binding.ref),
      })),
    ),
    Promise.all(
      resource.spec.contextStores.map(async (binding) => ({
        namespace: binding.namespace,
        required: binding.required,
        contribution: await resolvers.resolveContextStore(binding.ref),
      })),
    ),
  ]);
  const capabilityTools: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] = [];
  const skillConfigs: IExpertAgentSkillsConfig[] = [];
  const mcpConfigs: IExpertAgentMcpConfig[] = [];
  for (const { binding, contribution } of capabilities) {
    if (binding.kind === "skill") {
      if (contribution.skills === undefined) {
        throw new PragmaDslError(`${binding.ref} does not provide a Skill.`);
      }
      skillConfigs.push(contribution.skills);
      continue;
    }
    const allowed = new Set(binding.tools ?? []);
    if (contribution.tools !== undefined) {
      capabilityTools.push(
        ...contribution.tools
          .filter((tool) => allowed.has(tool.name))
          .map((tool) => ({
            ...tool,
            approval: mergeExpertAgentToolApprovals(tool.approval, {
              mode: resource.spec.toolApprovals[tool.name] ?? tool.approval?.mode ?? "ask",
            }),
          })),
      );
    }
    if (contribution.mcp !== undefined) {
      mcpConfigs.push(filterMcpContribution(contribution.mcp, allowed, resource));
    }
  }
  return await defineExpert({
    id: resource.metadata.id,
    name: resource.metadata.name,
    description: resource.metadata.description,
    tags: resource.metadata.tags,
    scope: resource.spec.scope,
    instructions: resource.spec.instructions,
    workspace: host.workspace,
    ...(host.pragmaHome === undefined ? {} : { pragmaHome: host.pragmaHome }),
    ...(host.loggerProvider === undefined ? {} : { loggerProvider: host.loggerProvider }),
    tools: [...tools, ...capabilityTools],
    ...(resource.spec.toolPolicy === undefined
      ? {}
      : {
          toolPolicy: {
            mode: resource.spec.toolPolicy.allowedTools === undefined ? "all" : "allow",
            ...(resource.spec.toolPolicy.allowedTools === undefined
              ? {}
              : { allowedTools: resource.spec.toolPolicy.allowedTools }),
            ...(resource.spec.toolPolicy.deniedTools === undefined
              ? {}
              : { deniedTools: resource.spec.toolPolicy.deniedTools }),
          },
        }),
    skills: mergeSkills(skillConfigs),
    mcp: mergeMcp(mcpConfigs),
    ...(executionOverride?.modelSelection !== undefined
      ? { models: { default: executionOverride.modelSelection } }
      : runtime?.models === undefined
        ? host.defaultModelSelection === undefined
          ? {}
          : { models: { default: host.defaultModelSelection } }
        : { models: runtime.models }),
    ...(executionOverride !== undefined
      ? { defaultRuntimeId: executionOverride.runtimeId }
      : runtime === undefined
        ? {}
        : { defaultRuntimeId: runtime.runtimeId }),
    contextSystem: createContextSystem(contextStores),
    plugins: plugins.map((plugin) => ({
      source: plugin.source,
      expectedRef: plugin.ref,
      packageFingerprint: plugin.packageFingerprint,
      ...(plugin.cachePolicy === undefined ? {} : { cachePolicy: plugin.cachePolicy }),
      userConfig: plugin.userConfig,
      ...(plugin.hostBindings === undefined ? {} : { hostBindings: plugin.hostBindings }),
    })),
  });
}

export function assertPluginResolution(
  expectedRef: string,
  resolution: PragmaPluginResolution,
): void {
  if (resolution.ref !== expectedRef) {
    throw new PragmaDslError(
      `Plugin resolver returned ${resolution.ref} for requested ${expectedRef}.`,
    );
  }
  for (const [name, value] of [
    ["packageFingerprint", resolution.packageFingerprint],
    ["verificationFingerprint", resolution.verificationFingerprint],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new PragmaDslError(`Plugin resolver returned an invalid ${name} for ${expectedRef}.`);
    }
  }
}

export async function compileFlowResource(
  resource: PragmaFlowResource,
  instantiate: (ref: string) => Promise<InvocableResource>,
  actions: FlowActionRegistry,
  contextPolicies: ContextPolicyRegistry,
  resolveRuntime: (ref: string) => Promise<PragmaRuntimeProfileContribution>,
): Promise<Flow> {
  const inputSchema = createJsonSchemaZod(resource.spec.input?.schema);
  const outputSchema = createJsonSchemaZod(resource.spec.output?.schema);
  const flow = defineFlow({
    id: resource.metadata.id,
    input: inputSchema,
    output: outputSchema,
    maxNodeVisits: resource.spec.limits.maxNodeVisits,
    timeoutMs: resource.spec.limits.timeoutMs,
    ...(resource.spec.output?.value === undefined
      ? {}
      : {
          result: ({
            input,
            state,
            terminal,
          }: {
            readonly input: unknown;
            readonly state: FlowState;
            readonly terminal: { readonly output: unknown };
          }) => evaluatePragmaFlowValue(resource.spec.output!.value, state, input, terminal.output),
        }),
  });
  const references = new Map<string, FlowStepReference>();
  for (const [stepId, step] of Object.entries(resource.spec.graph.steps)) {
    const mappedInput =
      step.input === undefined
        ? undefined
        : ({ state, flowInput }: { state: FlowState; flowInput: unknown }) =>
            evaluatePragmaFlowValue(step.input, state, flowInput);
    const promptInput =
      step.prompt === undefined
        ? undefined
        : ({ state, flowInput }: { state: FlowState; flowInput: unknown }) =>
            renderPragmaFlowPrompt(step.prompt!, state, flowInput);
    const descriptor = {
      ...(step.input === undefined ? {} : { input: step.input }),
      ...(step.prompt === undefined ? {} : { prompt: step.prompt }),
      ...(step.output === undefined ? {} : { output: step.output }),
      ...(step.runtime === undefined ? {} : { runtime: step.runtime }),
    };
    if (step.action !== undefined) {
      const action = actions.resolve(step.action.ref);
      references.set(
        stepId,
        flow.task({
          id: stepId,
          input: mappedInput,
          descriptor,
          inputSchema: createJsonSchemaZod(action.inputSchema),
          outputSchema: createJsonSchemaZod(action.outputSchema),
          handler: async (context) => await action.execute(context),
        }),
      );
      continue;
    }
    if (step.human !== undefined) {
      const selectionSchema =
        step.human.selectionMode === "single"
          ? z.object({ selection: z.string().min(1) })
          : z.object({ selection: z.array(z.string().min(1)).min(1) });
      references.set(
        stepId,
        flow.humanTask({
          id: stepId,
          input: mappedInput,
          output: selectionSchema,
          descriptor,
          request: ({ input: stepInput, state }) =>
            compileHumanRequest(step.human!, state, stepInput),
        }),
      );
      continue;
    }
    const targetRef = step.expert?.ref ?? step.team?.ref ?? step.flow?.ref;
    if (targetRef === undefined) throw new PragmaDslError(`Flow step has no target: ${stepId}`);
    const target = await instantiate(targetRef);
    const runtimeProfile =
      step.runtime === undefined ? undefined : await resolveRuntime(step.runtime.ref);
    const runtime = runtimeProfile?.runtimeId;
    const modelSelection = step.runtime?.modelSelection ?? runtimeProfile?.models?.default;
    const runtimeEntries = await Promise.all(
      Object.entries(step.runtimes ?? {}).map(
        async ([expertId, runtimeRef]) =>
          [expertId, (await resolveRuntime(runtimeRef)).runtimeId] as const,
      ),
    );
    const options = {
      input: promptInput,
      output: createJsonSchemaZod(step.output?.schema),
      descriptor,
      runtime,
      runtimeByExpert: Object.fromEntries(runtimeEntries),
      modelSelection,
      contextId: step.context === undefined ? undefined : contextPolicies.resolve(step.context),
    };
    references.set(
      stepId,
      "kind" in target && target.kind === "flow"
        ? flow.use(stepId, target, { input: mappedInput, descriptor, runtime })
        : flow.use(stepId, target as ExpertDefinition, options),
    );
  }
  const start = references.get(resource.spec.graph.start);
  if (start === undefined)
    throw new PragmaDslError(`Unknown Flow start: ${resource.spec.graph.start}`);
  flow.compose(({ start: begin }) => begin(start));

  const loopMembers = validateAndReadLoopMembers(resource);
  for (const [loopId, loop] of Object.entries(resource.spec.graph.loops)) {
    flow.loop({
      id: loopId,
      entry: requireStepReference(references, loop.entry),
      steps: [...(loopMembers.get(loopId) ?? [])].map((id) => requireStepReference(references, id)),
      maxIterations: loop.maxIterations,
      onLimit: loop.onLimit === undefined ? undefined : compileTarget(loop.onLimit, references),
    });
  }
  for (const [stepId, transition] of Object.entries(resource.spec.graph.transitions)) {
    flow.setTransition(stepId, compileTransition(transition, references));
  }
  return flow.compile();
}

function compileTransition(
  transition: PragmaFlowTransition,
  references: ReadonlyMap<string, FlowStepReference>,
) {
  if (
    typeof transition === "string" ||
    "goto" in transition ||
    "end" in transition ||
    "fail" in transition
  ) {
    return { type: "next" as const, target: compileTarget(transition, references) };
  }

  if ("repeat" in transition) {
    return {
      type: "repeat" as const,
      loopId: transition.repeat.loop,
      target: requireStepReference(references, transition.repeat.goto),
    };
  }
  if ("branches" in transition) {
    return {
      type: "array-route" as const,
      field: transition.route,
      branches: transition.branches.map((branch) => ({
        id: branch.id,
        operator: branch.operator,
        values: [...branch.values],
        destination: compileDestination(branch.destination, references),
      })),
      fallback:
        transition.fallback === undefined
          ? undefined
          : compileDestination(transition.fallback, references),
    };
  }
  return {
    type: "route" as const,
    field: transition.route,
    cases: new Map(
      Object.entries(transition.cases).map(([key, target]) => [
        key,
        compileDestination(target, references),
      ]),
    ),
    fallback:
      transition.fallback === undefined
        ? undefined
        : compileDestination(transition.fallback, references),
  };
}

function compileDestination(
  target: PragmaFlowDestination,
  references: ReadonlyMap<string, FlowStepReference>,
) {
  return typeof target === "object" && "repeat" in target
    ? {
        type: "repeat" as const,
        loopId: target.repeat.loop,
        target: requireStepReference(references, target.repeat.goto),
      }
    : compileTarget(target, references);
}

function compileTarget(
  target: PragmaFlowTarget,
  references: ReadonlyMap<string, FlowStepReference>,
): FlowStepReference | FlowTerminal {
  if (typeof target === "string") return requireStepReference(references, target);
  if ("goto" in target) return requireStepReference(references, target.goto);
  if ("end" in target) return { type: "end" };
  return { type: "fail", reason: target.fail };
}

function compileHumanRequest(
  request: NonNullable<PragmaFlowResource["spec"]["graph"]["steps"][string]["human"]>,
  state: FlowState,
  input: unknown,
) {
  const question = renderPragmaFlowPrompt(request.prompt, state, input);
  return {
    kind: "question" as const,
    prompt: question,
    questions: [
      {
        header: "Selection",
        question,
        kind:
          request.selectionMode === "single"
            ? ("single_choice" as const)
            : ("multiple_choice" as const),
        options: request.options.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description ?? "",
        })),
      },
    ],
  };
}

function filterMcpContribution(
  contribution: IExpertAgentMcpConfig,
  allowed: ReadonlySet<string>,
  resource: PragmaExpertResource,
): IExpertAgentMcpConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(contribution.mcpServers).map(([key, server]) => [
        key,
        {
          ...server,
          allowTools: [...allowed],
          toolApprovals: Object.fromEntries(
            [...allowed].map((toolName) => [
              toolName,
              mergeExpertAgentToolApprovals(server.toolApprovals?.[toolName], {
                mode:
                  resource.spec.toolApprovals[
                    `mcp_${key}_${sanitizeExecutionToolName(toolName)}`
                  ] ??
                  resource.spec.toolApprovals[toolName] ??
                  "ask",
              })!,
            ]),
          ),
        },
      ]),
    ),
  };
}

function mergeSkills(
  configs: readonly IExpertAgentSkillsConfig[],
): IExpertAgentSkillsConfig | undefined {
  const skills = configs.flatMap((config) => config.skills);
  return skills.length === 0 ? undefined : { skills };
}

function mergeMcp(configs: readonly IExpertAgentMcpConfig[]): IExpertAgentMcpConfig | undefined {
  const servers: IExpertAgentMcpConfig["mcpServers"] = {};
  for (const config of configs) {
    for (const [key, server] of Object.entries(config.mcpServers)) {
      if (servers[key] !== undefined) throw new PragmaDslError(`Duplicate MCP server key: ${key}`);
      servers[key] = server;
    }
  }
  return Object.keys(servers).length === 0 ? undefined : { mcpServers: servers };
}

export function createAdapterHost(
  host: PragmaCompileHost,
  artifacts: ReadonlyMap<string, string>,
  artifactsAreImmutable: boolean,
) {
  const external = host.adapterHost;
  const root = resolve(host.projectRoot ?? external?.projectRoot ?? host.workspace);
  return {
    environmentId: host.environmentId ?? external?.environmentId ?? "default",
    projectRoot: root,
    async resolveBinding(
      ref: Parameters<NonNullable<PragmaCompileHost["adapterHost"]>["resolveBinding"]>[0],
    ) {
      return await external?.resolveBinding(ref);
    },
    async resolveArtifact(
      source: Parameters<NonNullable<PragmaCompileHost["adapterHost"]>["resolveArtifact"]>[0],
    ) {
      if (source.type !== "project") {
        if (external === undefined) {
          throw new Error(`No artifact resolver configured for: ${source.uri}`);
        }
        return await external.resolveArtifact(source);
      }
      const canonicalRoot = await realpath(root);
      const path = await realpath(resolve(root, source.path));
      const child = relative(canonicalRoot, path);
      if (child.startsWith("..") || isAbsolute(child)) {
        throw new Error(`Artifact source escapes the project root: ${source.path}`);
      }
      const info = await lstat(path);
      const contentHash = artifacts.get(source.path);
      if (contentHash === undefined) {
        throw new Error(`Project artifact was not indexed: ${source.path}`);
      }
      return {
        source,
        path,
        contentHash,
        ...(artifactsAreImmutable ? { verified: true } : {}),
        ...(info.isFile() ? { text: await readFile(path, "utf8") } : {}),
      };
    },
    async resolveSecret(ref: string) {
      return await external?.resolveSecret(ref);
    },
    ...(external?.openFileContextStore === undefined
      ? {}
      : { openFileContextStore: external.openFileContextStore }),
  };
}
