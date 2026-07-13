import { randomUUID } from "node:crypto";

import type {
  AgentMessageUsage,
  Invocation,
  RuntimeContextSnapshot as SharedRuntimeContextSnapshot,
} from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import {
  createTeamDelegationTool,
  isAgentDelegationTool,
  readAgentDelegationDefinition,
  type AgentDelegationDefinition,
  type DelegationContextPolicy,
} from "../agent/agent-launcher.ts";
import { isExpertTeam, type ExpertDefinition, type ExpertTeam } from "../agent/expert-team.ts";
import type { RuntimeAgentSession } from "../runtime/runtime-adapter.ts";
import { mergeUsage } from "../runtime/usage.ts";
import { openRuntimeSession } from "../runtime/session-factory.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";
import type { ExpertAgentHumanRequest, ExpertAgentHumanResponse } from "../tools/managed-tool.ts";
import {
  ExecutionFinalStatusConflictError,
  ExecutionVersionConflictError,
  type ExecutionStore,
} from "./execution-store.ts";
import { RuntimeSessionPool, type RuntimeSessionIdentity } from "./runtime-session-pool.ts";

export type RuntimeContextSnapshot = SharedRuntimeContextSnapshot;

export class ExecutionController {
  private readonly activeRuntimeSessions = new Map<string, RuntimeAgentSession>();
  private readonly pendingInteractions = new Map<
    string,
    {
      resolve(value: ExpertAgentHumanResponse): void;
      reject(reason: unknown): void;
      requestId?: string;
    }
  >();
  private cancelled = false;
  private usage: AgentMessageUsage | undefined;

  constructor(
    readonly executionId: string,
    readonly store: ExecutionStore,
    private readonly runtimeSessions: RuntimeSessionPool = new RuntimeSessionPool(),
  ) {}

  isCancelled(): boolean {
    return this.cancelled;
  }

  addUsage(usage: AgentMessageUsage | undefined): void {
    this.usage = mergeUsage(this.usage, usage);
  }

  getUsage(): AgentMessageUsage | undefined {
    return this.usage;
  }

  async acquireRuntime(
    identity: RuntimeSessionIdentity,
    create: () => Promise<RuntimeAgentSession>,
  ): Promise<RuntimeAgentSession> {
    const session = await this.runtimeSessions.acquire(identity, create);
    this.activeRuntimeSessions.set(identity.contextId, session);
    if (this.cancelled) {
      await session.cancelCurrentSubmission();
      throw new Error(`Execution cancelled: ${this.executionId}`);
    }
    return session;
  }

  async releaseRuntime(identity: RuntimeSessionIdentity): Promise<void> {
    this.activeRuntimeSessions.delete(identity.contextId);
    await this.runtimeSessions.release(identity);
  }

  async requestHumanInteraction(
    invocationId: string,
    request: ExpertAgentHumanRequest,
    interactionId: string = randomUUID(),
  ): Promise<ExpertAgentHumanResponse> {
    if (this.cancelled) throw new Error("Execution was cancelled.");
    await this.store.appendEvent(
      this.executionId,
      invocationId,
      "human.requested",
      {
        interactionId,
        request,
      },
      `human-request:${interactionId}`,
    );
    if (this.cancelled) throw new Error("Execution was cancelled.");
    return await new Promise((resolve, reject) => {
      this.pendingInteractions.set(interactionId, { resolve, reject });
    });
  }

  async respond(interactionId: string, response: unknown, requestId: string): Promise<void> {
    const pending = this.pendingInteractions.get(interactionId);
    if (pending === undefined) {
      const responded = (await this.store.readEvents(this.executionId)).find(
        (event) =>
          event.type === "human.responded" &&
          (event.data as { interactionId?: unknown }).interactionId === interactionId,
      );
      if (responded !== undefined) {
        if ((responded.data as { requestId?: unknown }).requestId === requestId) return;
        throw new Error(`Human interaction idempotency conflict: ${interactionId}`);
      }
      throw new Error(`Human interaction is not pending: ${interactionId}`);
    }
    if (pending.requestId !== undefined) {
      if (pending.requestId === requestId) return;
      throw new Error(`Human interaction idempotency conflict: ${interactionId}`);
    }
    pending.requestId = requestId;
    await this.store.appendEvent(
      this.executionId,
      (await this.store.get(this.executionId))!.rootInvocationId,
      "human.responded",
      { interactionId, requestId, response },
      requestId,
    );
    this.pendingInteractions.delete(interactionId);
    pending.resolve(response as ExpertAgentHumanResponse);
  }

  async cancel(reason?: string): Promise<void> {
    this.cancelled = true;
    const cancellation = new Error(reason ?? `Execution cancelled: ${this.executionId}`);
    for (const pending of this.pendingInteractions.values()) pending.reject(cancellation);
    this.pendingInteractions.clear();
    await Promise.allSettled(
      [...this.activeRuntimeSessions.values()].map((runtime) => runtime.cancelCurrentSubmission()),
    );
    while (true) {
      const record = await this.store.get(this.executionId);
      if (record === undefined || isTerminal(record.status)) return;
      const invocationPatches = (await this.store.listInvocations(this.executionId))
        .filter((invocation) => !isTerminal(invocation.status))
        .map((invocation) => ({
          invocationId: invocation.invocationId,
          patch: { status: "cancelled" as const, error: reason },
        }));
      try {
        await this.store.commit({
          commitId: randomUUID(),
          executionId: this.executionId,
          expectedVersion: record.version,
          executionPatch: { status: "cancelled", error: reason },
          invocationPatches,
          events: [
            {
              invocationId: record.rootInvocationId,
              type: "execution.cancelled",
              data: { reason },
            },
          ],
        });
        return;
      } catch (error) {
        if (
          error instanceof ExecutionVersionConflictError ||
          error instanceof ExecutionFinalStatusConflictError
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  async steer(
    contextId: string,
    request: { readonly requestId: string; readonly content: string; readonly targetRunId: string },
  ): Promise<void> {
    const runtime = this.activeRuntimeSessions.get(contextId);
    if (runtime === undefined) throw new Error("Cannot steer without an active Runtime Session.");
    await runtime.steer(request);
  }

  async closeRuntimes(): Promise<void> {
    await this.runtimeSessions.close();
    this.activeRuntimeSessions.clear();
  }
}

export interface RunExpertInvocationOptions {
  readonly executionId: string;
  readonly invocationId: string;
  readonly parentInvocationId?: string | undefined;
  readonly expert: ExpertDefinition;
  readonly prompt: string;
  readonly owner:
    | { readonly type: "expert-session"; readonly ownerId: string }
    | { readonly type: "flow-execution"; readonly ownerId: string };
  readonly runtimeId?: string | undefined;
  readonly contextId: string;
  readonly runtimeSnapshot?: RuntimeContextSnapshot | undefined;
  readonly runtimeScope?: "invocation" | "session" | undefined;
  readonly controller: ExecutionController;
  readonly store: ExecutionStore;
  readonly runtimes: RuntimeRegistry;
  readonly team?: ExpertTeam | undefined;
  readonly depth?: number | undefined;
  readonly contextForMember?:
    | ((
        expertId: string,
        policy: DelegationContextPolicy,
      ) => {
        readonly contextId: string;
        readonly snapshot?: RuntimeContextSnapshot | undefined;
      })
    | undefined;
  readonly onRuntimeContext?:
    | ((contextId: string, snapshot: RuntimeContextSnapshot) => Promise<void>)
    | undefined;
  readonly delegationState?: DelegationExecutionState | undefined;
  readonly delegationPermit?: DelegationPermit | undefined;
}

export async function runExpertInvocation(options: RunExpertInvocationOptions): Promise<unknown> {
  const team = isExpertTeam(options.expert) ? options.expert : options.team;
  const nativeExpert = isExpertTeam(options.expert) ? options.expert.coordinator : options.expert;
  const depth = options.depth ?? 0;
  const teamTool = team === undefined ? undefined : createTeamDelegationTool(team, nativeExpert.id);
  const executableExpert =
    team === undefined ? nativeExpert : withTeamDelegationTool(nativeExpert, teamTool);
  const delegation =
    teamTool === undefined
      ? team === undefined
        ? readExpertDelegationDefinition(nativeExpert)
        : undefined
      : readAgentDelegationDefinition(teamTool);
  const delegationState =
    options.delegationState ??
    (delegation === undefined
      ? undefined
      : new DelegationExecutionState(delegation.maxConcurrency, delegation.maxDepth));
  const invocation = await requireInvocation(
    options.store,
    options.executionId,
    options.invocationId,
  );
  if (invocation.status === "succeeded") {
    options.controller.addUsage(invocation.usage);
    return invocation.output;
  }
  await options.store.commit({
    commitId: randomUUID(),
    executionId: options.executionId,
    invocationPatches: [{ invocationId: options.invocationId, patch: { status: "running" } }],
    events: [
      {
        invocationId: options.invocationId,
        type: "invocation.started",
        data: { expertId: nativeExpert.id },
      },
    ],
  });

  const runtimeId = options.runtimeId ?? options.runtimeSnapshot?.runtimeId;
  const runtime = options.runtimes.resolve(runtimeId);
  const runtimeIdentity = {
    contextId: options.contextId,
    expertId: nativeExpert.id,
    runtimeId: runtime.descriptor.id,
  } satisfies RuntimeSessionIdentity;
  if (
    options.runtimeSnapshot !== undefined &&
    (options.runtimeSnapshot.expertId !== runtimeIdentity.expertId ||
      options.runtimeSnapshot.runtimeId !== runtimeIdentity.runtimeId)
  ) {
    throw new Error(
      `Runtime context ${options.contextId} is bound to ${options.runtimeSnapshot.expertId}/${options.runtimeSnapshot.runtimeId} and cannot be reused with ${runtimeIdentity.expertId}/${runtimeIdentity.runtimeId}.`,
    );
  }
  const persistRuntimeSnapshot = async (snapshot: RuntimeContextSnapshot): Promise<void> => {
    if (options.runtimeScope === "invocation") {
      const latest = await requireInvocation(
        options.store,
        options.executionId,
        options.invocationId,
      );
      await options.store.putInvocation(options.executionId, {
        ...latest,
        runtimeContext: { contextId: options.contextId, ...snapshot },
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    await options.onRuntimeContext?.(options.contextId, snapshot);
  };
  const executionContext = {
    executionId: options.executionId,
    invocationId: options.invocationId,
    depth,
    ...(delegation === undefined || delegationState === undefined
      ? {}
      : {
          delegate: async (request: {
            readonly expertId: string;
            readonly prompt: string;
            readonly context?: "fresh" | "reuse" | undefined;
            readonly runtime?: string | undefined;
          }) =>
            await delegate({
              ...options,
              team,
              delegation,
              delegationState,
              sourceExpertId: nativeExpert.id,
              depth,
              request,
            }),
        }),
  };
  const humanInteractionHandler = async (request: ExpertAgentHumanRequest) =>
    await options.controller.requestHumanInteraction(options.invocationId, request);
  const session = await options.controller.acquireRuntime(runtimeIdentity, async () => {
    const opened = await openRuntimeSession(runtime, {
      agent: executableExpert,
      owner:
        options.owner.type === "expert-session"
          ? { ...options.owner, contextId: options.contextId }
          : { ...options.owner, invocationId: options.invocationId },
      systemSessionId: options.runtimeSnapshot?.systemSessionId,
      runtimeSession: options.runtimeSnapshot?.runtimeSession,
      executionContext,
      humanInteractionHandler,
      onSessionInfo: async (info) => {
        if (info.runtimeSession.id === "") return;
        await persistRuntimeSnapshot({
          expertId: nativeExpert.id,
          runtimeId: runtime.descriptor.id,
          systemSessionId: info.systemSessionId,
          runtimeSession: info.runtimeSession,
        });
      },
    });
    const info = opened.info();
    if (info.runtimeSession.id !== "") {
      await persistRuntimeSnapshot({
        expertId: nativeExpert.id,
        runtimeId: runtime.descriptor.id,
        systemSessionId: info.systemSessionId,
        runtimeSession: info.runtimeSession,
      });
    }
    return opened;
  });

  const handle = session.submit({
    runId: options.invocationId,
    query: options.prompt,
    execution: {
      context: executionContext,
      humanInteractionHandler,
    },
  });
  const drain = (async () => {
    for await (const event of handle.events) {
      await options.store.appendEvent(
        options.executionId,
        options.invocationId,
        "runtime.stream",
        event,
        event.eventId,
      );
    }
  })();

  try {
    const result = await handle.result;
    options.controller.addUsage(result.result.usage);
    await drain;
    const output = result.result.output;
    await options.store.commit({
      commitId: `invocation-succeeded:${options.invocationId}`,
      executionId: options.executionId,
      invocationPatches: [
        {
          invocationId: options.invocationId,
          patch: {
            status: "succeeded",
            output,
            ...(result.result.usage === undefined ? {} : { usage: result.result.usage }),
          },
        },
      ],
      events: [
        {
          invocationId: options.invocationId,
          type: "invocation.succeeded",
          data: {
            output,
            ...(result.result.usage === undefined ? {} : { usage: result.result.usage }),
          },
        },
      ],
    });
    const info = session.info();
    await persistRuntimeSnapshot({
      expertId: nativeExpert.id,
      runtimeId: runtime.descriptor.id,
      systemSessionId: info.systemSessionId,
      runtimeSession: info.runtimeSession,
    });
    return output;
  } catch (error) {
    await drain.catch(() => undefined);
    const status = options.controller.isCancelled() ? "cancelled" : "failed";
    const storedError = serializeError(error);
    const latest = await options.store.getInvocation(options.executionId, options.invocationId);
    if (latest !== undefined && !isTerminal(latest.status)) {
      await options.store.commit({
        commitId: `invocation-${status}:${options.invocationId}`,
        executionId: options.executionId,
        invocationPatches: [
          { invocationId: options.invocationId, patch: { status, error: storedError } },
        ],
        events: [
          {
            invocationId: options.invocationId,
            type: `invocation.${status}`,
            data: { message: error instanceof Error ? error.message : String(error) },
          },
        ],
      });
    }
    throw error;
  }
}

async function delegate(
  options: RunExpertInvocationOptions & {
    readonly team?: ExpertTeam | undefined;
    readonly delegation: AgentDelegationDefinition;
    readonly delegationState: DelegationExecutionState;
    readonly sourceExpertId: string;
    readonly depth: number;
    readonly request: {
      readonly expertId: string;
      readonly prompt: string;
      readonly context?: DelegationContextPolicy | undefined;
      readonly runtime?: string | undefined;
    };
  },
): Promise<{ readonly invocationId: string; readonly output: unknown }> {
  if (options.depth >= options.delegationState.maxDepth) {
    throw new Error(`Expert delegation depth exceeded: ${options.delegationState.maxDepth}`);
  }
  const expert = options.delegation.experts.find(
    (candidate) => candidate.id === options.request.expertId,
  );
  if (expert === undefined) {
    throw new Error(
      `Expert ${options.sourceExpertId} may not delegate to ${options.request.expertId}.`,
    );
  }
  const policy = options.request.context ?? options.delegation.context;
  const context = options.contextForMember?.(expert.id, policy) ?? {
    contextId: policy === "reuse" ? expert.id : randomUUID(),
  };
  const invocationId = randomUUID();
  const now = new Date().toISOString();
  const delegatedInvocation: Invocation = {
    invocationId,
    rootInvocationId: (await options.store.get(options.executionId))!.rootInvocationId,
    parentInvocationId: options.invocationId,
    definition: { id: expert.id, version: expert.version, kind: "expert" },
    executorId: expert.id,
    status: "queued",
    input: options.request.prompt,
    createdAt: now,
    updatedAt: now,
  };
  await options.store.commit({
    commitId: randomUUID(),
    executionId: options.executionId,
    invocationPuts: [delegatedInvocation],
    events: [
      {
        invocationId,
        type: "invocation.queued",
        data: { parentInvocationId: options.invocationId },
      },
    ],
  });
  const resumeParentPermit = options.delegationPermit?.suspend();
  let permit: DelegationPermit | undefined;
  try {
    permit = await options.delegationState.acquire();
    const output = await runExpertInvocation({
      ...options,
      invocationId,
      parentInvocationId: options.invocationId,
      expert,
      prompt: options.request.prompt,
      runtimeId: options.request.runtime,
      contextId: context.contextId,
      runtimeSnapshot: context.snapshot,
      runtimeScope:
        options.owner.type === "flow-execution"
          ? "invocation"
          : policy === "fresh"
            ? "invocation"
            : "session",
      delegationState: options.delegationState,
      delegationPermit: permit,
      depth: options.depth + 1,
    });
    return { invocationId, output };
  } finally {
    try {
      if (policy === "fresh") {
        const runtime = options.runtimes.resolve(
          options.request.runtime ?? context.snapshot?.runtimeId,
        );
        await options.controller.releaseRuntime({
          contextId: context.contextId,
          expertId: expert.id,
          runtimeId: runtime.descriptor.id,
        });
      }
    } finally {
      permit?.release();
      await resumeParentPermit?.();
    }
  }
}

function withTeamDelegationTool(
  expert: Expert,
  tool: NonNullable<Expert["tools"]>[number] | undefined,
): Expert {
  const clone = Object.create(Object.getPrototypeOf(expert)) as Expert;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(expert));
  Object.defineProperty(clone, "tools", {
    value: [
      ...(expert.tools ?? []).filter((candidate) => !isAgentDelegationTool(candidate)),
      ...(tool === undefined ? [] : [tool]),
    ],
    enumerable: true,
  });
  return clone;
}

function readExpertDelegationDefinition(expert: Expert): AgentDelegationDefinition | undefined {
  const definitions = (expert.tools ?? []).flatMap((tool) => {
    const definition = readAgentDelegationDefinition(tool);
    return definition === undefined ? [] : [definition];
  });
  if (definitions.length > 1) {
    throw new Error(`Expert ${expert.id} has multiple delegation launchers.`);
  }
  const definition = definitions[0];
  if (definition?.experts.some((candidate) => candidate.id === expert.id) === true) {
    throw new Error(`Expert ${expert.id} may not delegate to itself.`);
  }
  return definition;
}

async function requireInvocation(
  store: ExecutionStore,
  executionId: string,
  invocationId: string,
): Promise<Invocation> {
  const invocation = await store.getInvocation(executionId, invocationId);
  if (invocation === undefined) throw new Error(`Invocation not found: ${invocationId}`);
  return invocation;
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function serializeError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}

class DelegationExecutionState {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    readonly maxDepth: number,
  ) {}

  async acquire(): Promise<DelegationPermit> {
    await this.acquireSlot();
    return new DelegationPermit(this);
  }

  async acquireSlot(): Promise<void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      return;
    }
    this.active += 1;
  }

  releaseSlot(): void {
    if (this.active < 1) {
      throw new Error("Delegation concurrency slot underflow.");
    }
    const next = this.waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.active -= 1;
  }
}

class DelegationPermit {
  private active = true;
  private released = false;
  private suspensionCount = 0;
  private resumeCycle:
    | { readonly promise: Promise<void>; readonly resolve: () => void }
    | undefined;

  constructor(private readonly state: DelegationExecutionState) {}

  suspend(): () => Promise<void> {
    if (this.released) {
      throw new Error("Cannot suspend a released delegation permit.");
    }
    if (!this.active && this.suspensionCount === 0) {
      throw new Error("Cannot suspend a delegation permit while it is resuming.");
    }

    this.suspensionCount += 1;
    if (this.suspensionCount === 1) {
      let resolve!: () => void;
      const promise = new Promise<void>((complete) => {
        resolve = complete;
      });
      this.resumeCycle = { promise, resolve };
      this.active = false;
      this.state.releaseSlot();
    }

    const cycle = this.resumeCycle;
    if (cycle === undefined) {
      throw new Error("Delegation permit resume cycle is missing.");
    }
    let resumed = false;

    return async () => {
      if (!resumed) {
        resumed = true;
        this.suspensionCount -= 1;
        if (this.suspensionCount === 0) {
          await this.state.acquireSlot();
          if (this.released) {
            this.state.releaseSlot();
          } else {
            this.active = true;
          }
          cycle.resolve();
          if (this.resumeCycle === cycle) this.resumeCycle = undefined;
        }
      }
      await cycle.promise;
    };
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.active) {
      this.active = false;
      this.state.releaseSlot();
    }
  }
}
