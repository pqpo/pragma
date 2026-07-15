import type {
  PragmaExpertResource,
  PragmaResource,
  PragmaToolBinding,
} from "../ast/pragma-dsl.schema.ts";

import {
  createAgentLauncher,
  freshContextIdResolver,
  type ContextIdResolver,
  type DefineExpertOptions,
  type Expert,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type ExpertDefinition,
  type Flow,
  type FlowTaskContext,
  type RuntimeRegistry,
} from "@pragma/core";

export type InvocableResource = ExpertDefinition | Flow;

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
      id: "pragma.context.fresh",
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
    const { id, version } = parseNamespacedReference(ref, "context");
    if (version === undefined) throw new Error(`Context policy must include a version: ${ref}`);
    const factory = this.factories.get(extensionKey(id, version));
    if (factory === undefined) throw new Error(`Context policy not found: ${ref}`);
    return factory.create();
  }
}

export interface ToolAdapterCompileContext {
  readonly binding: PragmaToolBinding;
  readonly targets: readonly InvocableResource[];
  readonly contextPolicies: ContextPolicyRegistry;
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
    const adapter = this.adapters.get(context.binding.adapter);
    if (adapter === undefined)
      throw new Error(`Tool Adapter not found: ${context.binding.adapter}`);
    return adapter.createTools(context);
  }
}

export interface PragmaCompileHost {
  readonly workspace: string;
  readonly runtimes?: RuntimeRegistry | undefined;
  readonly actions?: FlowActionRegistry | undefined;
  readonly contextPolicies?: ContextPolicyRegistry | undefined;
  readonly toolAdapters?: ToolAdapterRegistry | undefined;
  readonly createExpert?:
    | ((input: {
        readonly resource: PragmaExpertResource;
        readonly tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[];
        readonly workspace: string;
      }) => Promise<Expert>)
    | undefined;
  readonly expertOptions?:
    | ((resource: PragmaExpertResource) => Partial<DefineExpertOptions>)
    | undefined;
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
  createTools({ binding, targets, contextPolicies }) {
    const experts = targets.filter((target): target is Expert => !("kind" in target));
    if (experts.length !== targets.length) {
      throw new Error("pragma.tool.delegate@v1 only supports Expert targets.");
    }
    const policy = binding.policy;
    return createAgentLauncher({
      experts,
      maxConcurrency: policy?.maxConcurrency,
      maxDepth: policy?.maxDepth,
      contextId: contextPolicies.resolve(policy?.context ?? "context:pragma.context.fresh@v1"),
      runtimeByExpert: policy?.runtimes,
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
        inputSchema: invocationInputSchema(target),
        approval: { mode: tool.approval },
        async call(input, signal, context) {
          if (signal?.aborted)
            return failure("resource_call_cancelled", "Resource call cancelled.");
          const invoke = context?.execution?.invokeResource;
          if (invoke === undefined) {
            return failure("missing_execution", "Resource calls require an active Execution.");
          }
          try {
            const output = await invoke({ target, input, signal });
            return {
              text: typeof output === "string" ? output : JSON.stringify(output, null, 2),
              details: output,
            };
          } catch (error) {
            return failure(
              "resource_call_failed",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      },
    ];
  },
};

function invocationInputSchema(target: InvocableResource): unknown {
  if ("kind" in target && target.kind === "flow") {
    return { type: "object", additionalProperties: true };
  }
  return {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
    additionalProperties: false,
  };
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
