import { randomUUID } from "node:crypto";

import type {
  AgentInstance,
  Invocation,
  RuntimeContextRecord,
  RuntimeContextOwner,
} from "@pragma/shared";

import {
  describeContextIdResolver,
  resolveContextId,
  type ContextCandidate,
  type ContextIdResolutionSource,
  type ContextIdResolver,
} from "./context-id-resolver.ts";
import type {
  ExecutionAgentPatch,
  ExecutionContextPatch,
  ExecutionStore,
  NewExecutionEvent,
} from "./execution-store.ts";
import {
  createRuntimeContextRecord,
  requireInvocationContextOrigin,
} from "./runtime-context-record.ts";

export interface ResolveRuntimeContextRequest {
  readonly executionId: string;
  readonly invocationId: string;
  readonly parentInvocationId?: string | undefined;
  readonly input: unknown;
  readonly state: Readonly<Record<string, unknown>>;
  readonly source: ContextIdResolutionSource;
  readonly owner: RuntimeContextOwner;
  readonly ownerContextId?: string | undefined;
  readonly expert: { readonly id: string; readonly version: string };
  readonly runtimeId: string;
  readonly resolver: ContextIdResolver;
  readonly freshContextId?: string | undefined;
}

export interface RuntimeContextResolution {
  readonly context: RuntimeContextRecord;
  readonly disposition: "created" | "reused";
  readonly resolver: { readonly id: string; readonly version: string };
  readonly contextPut?: RuntimeContextRecord | undefined;
  readonly events: readonly NewExecutionEvent[];
}

export interface ContextResolutionScopeSnapshot {
  readonly contexts: readonly RuntimeContextRecord[];
  readonly invocations: readonly Invocation[];
  readonly agents: readonly AgentInstance[];
}

export type ContextResolutionScopeReader = () => Promise<ContextResolutionScopeSnapshot>;

export class ContextResolutionService {
  constructor(
    private readonly store: ExecutionStore,
    private readonly readOwnerScope?: ContextResolutionScopeReader,
  ) {}

  async resolve(request: ResolveRuntimeContextRequest): Promise<RuntimeContextResolution> {
    const [localContexts, localInvocations, localAgents, ownerScope] = await Promise.all([
      this.store.listContexts(request.executionId),
      this.store.listInvocations(request.executionId),
      this.store.listAgents(request.executionId),
      this.readOwnerScope?.(),
    ]);
    const contexts = mergeById(
      localContexts,
      ownerScope?.contexts ?? [],
      (context) => context.contextId,
    );
    const invocations = mergeById(
      ownerScope?.invocations ?? [],
      localInvocations,
      (invocation) => invocation.invocationId,
    );
    const agents = mergeById(ownerScope?.agents ?? [], localAgents, (agent) => agent.agentId);
    const previousContexts = selectCompatibleCandidates(request, contexts, invocations, agents);
    const contextId = resolveContextId(request.resolver, {
      source: request.source,
      executionId: request.executionId,
      owner: request.owner,
      ...(request.ownerContextId === undefined ? {} : { ownerContextId: request.ownerContextId }),
      target: {
        expertId: request.expert.id,
        expertVersion: request.expert.version,
        runtimeId: request.runtimeId,
      },
      invocation: {
        ...(request.parentInvocationId === undefined
          ? {}
          : { parentInvocationId: request.parentInvocationId }),
        input: request.input,
      },
      state: request.state,
      previousContexts,
      freshContextId: request.freshContextId ?? randomUUID(),
    });
    const localExisting = localContexts.find((candidate) => candidate.contextId === contextId);
    const existing = contexts.find((candidate) => candidate.contextId === contextId);
    const disposition = existing === undefined ? "created" : "reused";
    const now = new Date().toISOString();
    const context =
      existing ??
      createRuntimeContextRecord({
        contextId,
        owner: request.owner,
        origin: { type: "invocation", invocationId: request.invocationId },
        expert: request.expert,
        runtimeId: request.runtimeId,
        now,
      });
    assertCompatibleContext(request, context, agents);
    const resolver = describeContextIdResolver(request.resolver);
    const eventData = {
      source: request.source,
      resolver,
      contextId,
      disposition,
    };
    return {
      context,
      disposition,
      resolver,
      ...(localExisting === undefined ? { contextPut: context } : {}),
      events: [
        {
          invocationId: request.invocationId,
          type: "context.resolved",
          data: eventData,
        },
        {
          invocationId: request.invocationId,
          type: disposition === "created" ? "context.created" : "context.reused",
          data: { contextId, resolver },
        },
      ],
    };
  }
}

function mergeById<TValue>(
  first: readonly TValue[],
  second: readonly TValue[],
  readId: (value: TValue) => string,
): TValue[] {
  const merged = new Map(first.map((value) => [readId(value), value]));
  for (const value of second) merged.set(readId(value), value);
  return [...merged.values()];
}

export async function closeExecutionContexts(
  store: ExecutionStore,
  executionId: string,
): Promise<void> {
  const closure = await prepareExecutionContextClosure(store, executionId);
  if (closure.contextPatches.length === 0 && closure.agentPatches.length === 0) return;
  await store.commit({
    commitId: `execution-contexts-closed:${executionId}`,
    executionId,
    contextPatches: closure.contextPatches,
    agentPatches: closure.agentPatches,
    events: closure.events,
  });
}

export interface ExecutionContextClosure {
  readonly contextPatches: readonly ExecutionContextPatch[];
  readonly agentPatches: readonly ExecutionAgentPatch[];
  readonly events: readonly NewExecutionEvent[];
}

export async function prepareExecutionContextClosure(
  store: ExecutionStore,
  executionId: string,
): Promise<ExecutionContextClosure> {
  const [contexts, agents] = await Promise.all([
    store.listContexts(executionId),
    store.listAgents(executionId),
  ]);
  const openContexts = contexts.filter((context) => context.lifecycle === "open");
  const openAgents = agents.filter((agent) => agent.lifecycle === "open");
  const now = new Date().toISOString();
  return {
    contextPatches: openContexts.map((context) => ({
      contextId: context.contextId,
      patch: { lifecycle: "closed" as const, closedAt: now },
    })),
    agentPatches: openAgents.map((agent) => ({
      agentId: agent.agentId,
      patch: { lifecycle: "closed" as const, closedAt: now, activeInvocationId: undefined },
    })),
    events: openContexts.map((context) => ({
      invocationId: requireInvocationContextOrigin(context),
      type: "context.closed",
      data: { contextId: context.contextId },
    })),
  };
}

function selectCompatibleCandidates(
  request: ResolveRuntimeContextRequest,
  contexts: readonly RuntimeContextRecord[],
  invocations: readonly Invocation[],
  agents: readonly AgentInstance[],
): ContextCandidate[] {
  const flowStepId = request.source.kind === "flow" ? request.source.stepId : undefined;
  const compatible = contexts.filter((context) => {
    if (!sameOwner(context.owner, request.owner)) return false;
    if (
      context.expert.id !== request.expert.id ||
      context.expert.version !== request.expert.version
    )
      return false;
    if (context.runtimeId !== request.runtimeId) return false;
    if (flowStepId !== undefined) {
      return invocations.some(
        (invocation) =>
          invocation.contextId === context.contextId && invocation.nodeId === flowStepId,
      );
    }
    return agents.some(
      (agent) =>
        agent.contextId === context.contextId &&
        agent.ownerContextId === request.ownerContextId &&
        agent.definition.id === request.expert.id &&
        agent.definition.version === request.expert.version,
    );
  });
  return compatible
    .flatMap((context): ContextCandidate[] => {
      const matching = invocations
        .filter((invocation) => invocation.contextId === context.contextId)
        .sort(compareInvocations);
      const last = matching.at(-1);
      if (last === undefined) return [];
      const agent = agents.find((candidate) => candidate.contextId === context.contextId);
      return [
        {
          contextId: context.contextId,
          ...(agent === undefined ? {} : { agentId: agent.agentId }),
          expertId: context.expert.id,
          expertVersion: context.expert.version,
          runtimeId: context.runtimeId,
          lifecycle: context.lifecycle,
          lastInvocationId: last.invocationId,
          lastInvocationStatus: last.status,
        } satisfies ContextCandidate,
      ];
    })
    .sort((left, right) => {
      const leftContext = contexts.find((entry) => entry.contextId === left.contextId)!;
      const rightContext = contexts.find((entry) => entry.contextId === right.contextId)!;
      return (
        leftContext.createdAt.localeCompare(rightContext.createdAt) ||
        compareInvocations(
          invocations.find((entry) => entry.invocationId === left.lastInvocationId)!,
          invocations.find((entry) => entry.invocationId === right.lastInvocationId)!,
        )
      );
    });
}

function assertCompatibleContext(
  request: ResolveRuntimeContextRequest,
  context: RuntimeContextRecord,
  agents: readonly AgentInstance[],
): void {
  if (!sameOwner(context.owner, request.owner)) {
    throw new Error(`Runtime Context owner conflict: ${context.contextId}.`);
  }
  if (
    context.expert.id !== request.expert.id ||
    context.expert.version !== request.expert.version
  ) {
    throw new Error(`Runtime Context Expert identity conflict: ${context.contextId}.`);
  }
  if (context.runtimeId !== request.runtimeId) {
    throw new Error(`Runtime Context Runtime identity conflict: ${context.contextId}.`);
  }
  if (context.lifecycle !== "open") {
    throw new Error(`Runtime Context is closed: ${context.contextId}.`);
  }
  if (request.source.kind !== "flow") {
    const foreignAgent = agents.find(
      (agent) =>
        agent.contextId === context.contextId && agent.ownerContextId !== request.ownerContextId,
    );
    if (foreignAgent !== undefined) {
      throw new Error(
        `Runtime Context is owned by another coordinator Context: ${context.contextId}.`,
      );
    }
  }
}

function sameOwner(left: RuntimeContextOwner, right: RuntimeContextOwner): boolean {
  return left.type === right.type && left.ownerId === right.ownerId;
}

function compareInvocations(left: Invocation, right: Invocation): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    (left.agentTaskSequence ?? 0) - (right.agentTaskSequence ?? 0) ||
    left.invocationId.localeCompare(right.invocationId)
  );
}
