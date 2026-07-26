import type {
  PragmaInvocableResource,
  PragmaDiagnostic,
  PragmaExpertResource,
  PragmaResource,
  PragmaToolBinding,
} from "../ast/pragma-dsl.schema.ts";

import {
  createAgentLauncher,
  freshContextIdResolver,
  type ContextIdResolver,
  type Expert,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type ExpertDefinition,
  type Flow,
  type FlowTaskContext,
  type RuntimeResolver,
  type RuntimeModelSelection,
  type PragmaLoggerProvider,
} from "@pragma/core";

import type { PragmaAdapterHost, PragmaResourceAdapterRegistry } from "./resource-adapters.ts";

export type InvocableResource = ExpertDefinition | Flow;

export interface PragmaPluginResolution {
  readonly ref: `plugin:${string}@${string}`;
  readonly source: string;
  readonly packageFingerprint: string;
  readonly cachePolicy?: "immutable" | "host-managed" | undefined;
  readonly verificationFingerprint: string;
  readonly userConfig: Readonly<Record<string, unknown>>;
  readonly hostBindings?: Readonly<Record<string, unknown>> | undefined;
}

export interface PragmaPluginInspection {
  readonly ref: `plugin:${string}@${string}`;
  readonly status: "ready" | "needs_attention";
  readonly packageFingerprint?: string | undefined;
  readonly verificationFingerprint?: string | undefined;
  readonly issues: readonly PragmaDiagnostic[];
}

export interface PragmaPluginResolver {
  readonly inspect: (input: {
    readonly expertRef: `expert:${string}`;
    readonly binding: PragmaExpertResource["spec"]["plugins"][number];
  }) => Promise<PragmaPluginInspection>;
  readonly resolve: (input: {
    readonly expertRef: `expert:${string}`;
    readonly binding: PragmaExpertResource["spec"]["plugins"][number];
  }) => Promise<PragmaPluginResolution>;
}

export interface FlowAction<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema?: unknown | undefined;
  readonly outputSchema?: unknown | undefined;
  readonly sideEffect?: "none" | "read" | "write" | undefined;
  readonly execute: (context: FlowTaskContext<TInput>) => TOutput | Promise<TOutput>;
}

export class FlowActionRegistry {
  private readonly actions = new Map<string, FlowAction>();

  register(action: FlowAction): this {
    const key = extensionKey(action.id, action.version);
    if (this.actions.has(key)) throw new Error(`Duplicate FlowAction: ${key}`);
    this.actions.set(key, action);
    return this;
  }

  resolve(ref: string): FlowAction {
    const { id, version } = parseNamespacedReference(ref, "action");
    if (version === undefined) {
      const matches = [...this.actions.values()].filter((action) => action.id === id);
      if (matches.length !== 1)
        throw new Error(`FlowAction reference is ambiguous or missing: ${ref}`);
      return matches[0]!;
    }
    const action = this.actions.get(extensionKey(id, version));
    if (action === undefined) throw new Error(`FlowAction not found: ${ref}`);
    return action;
  }
}

export interface ContextPolicyFactory {
  readonly id: string;
  readonly version: string;
  readonly create: () => ContextIdResolver;
}

export class ContextPolicyRegistry {
  private readonly factories = new Map<string, ContextPolicyFactory>();

  constructor() {
    this.register({
      id: "pragma.fresh",
      version: "v1",
      create: () => freshContextIdResolver,
    });
  }

  register(factory: ContextPolicyFactory): this {
    const key = extensionKey(factory.id, factory.version);
    if (this.factories.has(key)) throw new Error(`Duplicate Context policy: ${key}`);
    this.factories.set(key, factory);
    return this;
  }

  resolve(ref: string): ContextIdResolver {
    const { id, version } = parseNamespacedReference(ref, "context-policy");
    if (version === undefined) throw new Error(`Context policy must include a version: ${ref}`);
    const factory = this.factories.get(extensionKey(id, version));
    if (factory === undefined) throw new Error(`Context policy not found: ${ref}`);
    return factory.create();
  }
}

export interface ToolAdapterCompileContext {
  readonly binding: PragmaToolBinding;
  readonly targets: readonly {
    readonly resource: PragmaInvocableResource;
    readonly value: InvocableResource;
  }[];
  readonly contextPolicies: ContextPolicyRegistry;
  readonly runtimeByExpert?: Readonly<Record<string, string>> | undefined;
}

export interface ResourceToolAdapter {
  readonly id: string;
  readonly version: string;
  readonly createTools: (
    context: ToolAdapterCompileContext,
  ) => readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[];
}

export class ToolAdapterRegistry {
  private readonly adapters = new Map<string, ResourceToolAdapter>();

  constructor() {
    this.register(delegateToolAdapter);
    this.register(callToolAdapter);
  }

  register(adapter: ResourceToolAdapter): this {
    const key = extensionKey(adapter.id, adapter.version);
    if (this.adapters.has(key)) throw new Error(`Duplicate Tool Adapter: ${key}`);
    this.adapters.set(key, adapter);
    return this;
  }

  createTools(
    context: ToolAdapterCompileContext,
  ): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] {
    return this.resolve(context.binding.adapter).createTools(context);
  }

  resolve(ref: string): ResourceToolAdapter {
    const adapter = this.adapters.get(ref);
    if (adapter === undefined) throw new Error(`Tool Adapter not found: ${ref}`);
    return adapter;
  }
}

export interface PragmaCompileHost {
  readonly workspace: string;
  readonly projectRoot?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly runtimes?: RuntimeResolver | undefined;
  readonly defaultModelSelection?: RuntimeModelSelection | undefined;
  readonly rootModelSelectionOverride?: RuntimeModelSelection | undefined;
  readonly rootExecutionOverride?:
    | {
        readonly runtimeId: string;
        readonly modelSelection?: RuntimeModelSelection | undefined;
      }
    | undefined;
  readonly actions?: FlowActionRegistry | undefined;
  readonly contextPolicies?: ContextPolicyRegistry | undefined;
  readonly toolAdapters?: ToolAdapterRegistry | undefined;
  readonly resourceAdapters?: PragmaResourceAdapterRegistry | undefined;
  readonly plugins?: PragmaPluginResolver | undefined;
  readonly adapterHost?: PragmaAdapterHost | undefined;
  readonly pragmaHome?: string | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
}

export interface DefinitionSerializer {
  readonly kind: PragmaResource["kind"];
  readonly canSerialize: (value: object) => boolean;
  readonly serialize: (value: object) => PragmaResource;
}

export class DefinitionSerializerRegistry {
  private readonly serializers: DefinitionSerializer[] = [];

  register(serializer: DefinitionSerializer): this {
    this.serializers.push(serializer);
    return this;
  }

  serialize(value: object): PragmaResource | undefined {
    return this.serializers.find((serializer) => serializer.canSerialize(value))?.serialize(value);
  }
}

const delegateToolAdapter: ResourceToolAdapter = {
  id: "pragma.tool.delegate",
  version: "v1",
  createTools({ binding, targets, contextPolicies, runtimeByExpert }) {
    const values = targets.map((target) => target.value);
    const experts = values.filter((target): target is Expert => !("kind" in target));
    if (experts.length !== values.length) {
      throw new Error("pragma.tool.delegate@v1 only supports Expert targets.");
    }
    const policy = binding.policy;
    return createAgentLauncher({
      experts,
      maxConcurrency: policy?.maxConcurrency,
      maxDepth: policy?.maxDepth,
      contextId: contextPolicies.resolve(policy?.context ?? "context-policy:pragma.fresh@v1"),
      runtimeByExpert,
    }).tools;
  },
};

const callToolAdapter: ResourceToolAdapter = {
  id: "pragma.tool.call",
  version: "v1",
  createTools({ binding, targets }) {
    if (targets.length !== 1 || binding.tool === undefined) {
      throw new Error("pragma.tool.call@v1 requires one target and a tool declaration.");
    }
    const target = targets[0]!;
    const tool = binding.tool;
    return [
      {
        name: tool.name,
        description: tool.description,
        inputSchema: invocationInputSchema(target.resource),
        ...(target.resource.kind === "Flow" && target.resource.spec.output?.schema !== undefined
          ? { outputSchema: target.resource.spec.output.schema }
          : {}),
        approval: { mode: tool.approval },
        async call(input, signal, context) {
          if (signal?.aborted)
            return failure("resource_call_cancelled", "Resource call cancelled.");
          const invoke = context?.execution?.invokeResource;
          if (invoke === undefined) {
            return failure("missing_execution", "Resource calls require an active Execution.");
          }
          const timeoutController = new AbortController();
          const timeout =
            tool.timeoutMs === undefined
              ? undefined
              : setTimeout(
                  () =>
                    timeoutController.abort(
                      new Error(`Resource call timed out after ${tool.timeoutMs}ms.`),
                    ),
                  tool.timeoutMs,
                );
          const invocationSignal =
            signal === undefined
              ? timeoutController.signal
              : AbortSignal.any([signal, timeoutController.signal]);
          try {
            const output = await invoke({ target: target.value, input, signal: invocationSignal });
            const text = serializeToolOutput(output);
            return {
              text,
              details: output,
            };
          } catch (error) {
            return failure(
              timeoutController.signal.aborted ? "resource_call_timeout" : "resource_call_failed",
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
          }
        },
      },
    ];
  },
};

function invocationInputSchema(target: PragmaInvocableResource): unknown {
  if (target.kind === "Flow") {
    return target.spec.input?.schema ?? { type: "object", additionalProperties: true };
  }
  return {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
    additionalProperties: false,
  };
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "null";
  const serialized = JSON.stringify(output, null, 2);
  if (serialized === undefined) throw new Error("Resource output is not JSON serializable.");
  return serialized;
}

function failure(code: string, message: string): ExpertAgentToolCallResult {
  return { text: message, isError: true, details: { code } };
}

function extensionKey(id: string, version: string): string {
  return `${id}@${version}`;
}

export function parseNamespacedReference(
  ref: string,
  expectedKind?: string,
): { readonly kind: string; readonly id: string; readonly version?: string | undefined } {
  const separator = ref.indexOf(":");
  if (separator < 1) throw new Error(`Invalid Pragma reference: ${ref}`);
  const kind = ref.slice(0, separator);
  if (expectedKind !== undefined && kind !== expectedKind) {
    throw new Error(`Expected ${expectedKind} reference, received: ${ref}`);
  }
  const value = ref.slice(separator + 1);
  const at = value.lastIndexOf("@");
  if (at < 0) return { kind, id: value };
  return { kind, id: value.slice(0, at), version: value.slice(at + 1) };
}
