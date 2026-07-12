import { randomUUID } from "node:crypto";

import type {
  AgentMessageUsage,
  Invocation,
  RuntimeContextSnapshot as SharedRuntimeContextSnapshot,
} from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import { createTeamDelegationTool } from "../agent/agent-launcher.ts";
import {
  isExpertTeam,
  type DelegationContextPolicy,
  type ExpertDefinition,
  type ExpertTeam,
} from "../agent/expert-team.ts";
import type { RuntimeAgentSession } from "../runtime/runtime-adapter.ts";
import { mergeUsage } from "../runtime/usage.ts";
import { openRuntimeSession } from "../runtime/session-factory.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";
import type { ExpertAgentHumanRequest, ExpertAgentHumanResponse } from "../tools/managed-tool.ts";
import type { ExecutionStore } from "./execution-store.ts";
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
          (event.payload as { interactionId?: unknown }).interactionId === interactionId,
      );
      if (responded !== undefined) {
        if ((responded.payload as { requestId?: unknown }).requestId === requestId) return;
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
    const record = await this.store.get(this.executionId);
    if (record !== undefined && !isTerminal(record.status)) {
      for (const invocation of await this.store.listInvocations(this.executionId)) {
        if (!isTerminal(invocation.status)) {
          await this.store.putInvocation(this.executionId, {
            ...invocation,
            status: "cancelled",
            error: reason,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      await this.store.appendEvent(
        this.executionId,
        record.rootInvocationId,
        "execution.cancelled",
        { reason },
      );
      await this.store.update(this.executionId, { status: "cancelled", error: reason });
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
  readonly sourceExpertId?: string | undefined;
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
  readonly limiter?: DelegationLimiter | undefined;
}

export async function runExpertInvocation(options: RunExpertInvocationOptions): Promise<unknown> {
  const team = isExpertTeam(options.expert) ? options.expert : options.team;
  const nativeExpert = isExpertTeam(options.expert) ? options.expert.coordinator : options.expert;
  const sourceExpertId = options.sourceExpertId ?? nativeExpert.id;
  const depth = options.depth ?? 0;
  const limiter =
    options.limiter ??
    (team === undefined ? undefined : new DelegationLimiter(team.delegation.maxConcurrency));
  const invocation = await requireInvocation(
    options.store,
    options.executionId,
    options.invocationId,
  );
  if (invocation.status === "succeeded") {
    options.controller.addUsage(invocation.usage);
    return invocation.output;
  }
  await updateInvocation(options.store, options.executionId, invocation, { status: "running" });
  await options.store.appendEvent(options.executionId, options.invocationId, "invocation.started", {
    expertId: nativeExpert.id,
  });

  const executableExpert =
    team === undefined
      ? nativeExpert
      : withAdditionalTool(nativeExpert, createTeamDelegationTool(team));
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
    ...(team === undefined
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
              limiter,
              team,
              sourceExpertId,
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
        `runtime.${event.type}`,
        event.payload,
        event.eventId,
      );
      const output = projectOutput(event);
      if (output !== undefined) {
        await options.store.appendOutput(
          options.executionId,
          options.invocationId,
          output,
          event.eventId,
        );
      }
    }
  })();

  try {
    const result = await handle.result;
    options.controller.addUsage(result.result.usage);
    await drain;
    const output = result.result.output;
    await options.store.appendOutput(options.executionId, options.invocationId, {
      channel: "result",
      value: output,
    });
    await options.store.appendEvent(
      options.executionId,
      options.invocationId,
      "invocation.succeeded",
      {
        output,
        ...(result.result.usage === undefined ? {} : { usage: result.result.usage }),
      },
    );
    await updateInvocation(options.store, options.executionId, invocation, {
      status: "succeeded",
      output,
      ...(result.result.usage === undefined ? {} : { usage: result.result.usage }),
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
    await options.store.appendEvent(
      options.executionId,
      options.invocationId,
      `invocation.${status}`,
      {
        message: error instanceof Error ? error.message : String(error),
      },
    );
    await updateInvocation(options.store, options.executionId, invocation, {
      status,
      error: serializeError(error),
    });
    throw error;
  }
}

async function delegate(
  options: RunExpertInvocationOptions & {
    readonly team: ExpertTeam;
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
  if (options.depth >= options.team.delegation.maxDepth) {
    throw new Error(`ExpertTeam delegation depth exceeded: ${options.team.delegation.maxDepth}`);
  }
  if (!options.team.delegation.allow.get(options.sourceExpertId)?.has(options.request.expertId)) {
    throw new Error(
      `Expert ${options.sourceExpertId} may not delegate to ${options.request.expertId}.`,
    );
  }
  const expert = options.team.members.find(
    (candidate) => candidate.id === options.request.expertId,
  );
  if (expert === undefined) throw new Error(`Unknown team member: ${options.request.expertId}`);
  const policy = options.request.context ?? options.team.delegation.context;
  const context = options.contextForMember?.(expert.id, policy) ?? {
    contextId: policy === "reuse" ? expert.id : randomUUID(),
  };
  const invocationId = randomUUID();
  const now = new Date().toISOString();
  await options.store.putInvocation(options.executionId, {
    invocationId,
    rootInvocationId: (await options.store.get(options.executionId))!.rootInvocationId,
    parentInvocationId: options.invocationId,
    definition: { id: expert.id, version: expert.version, kind: "expert" },
    executorId: expert.id,
    status: "queued",
    input: options.request.prompt,
    createdAt: now,
    updatedAt: now,
  });
  await options.store.appendEvent(options.executionId, invocationId, "invocation.queued", {
    parentInvocationId: options.invocationId,
  });
  const release = await options.limiter?.acquire();
  try {
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
      sourceExpertId: expert.id,
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
      release?.();
    }
  }
}

function withAdditionalTool(expert: Expert, tool: NonNullable<Expert["tools"]>[number]): Expert {
  const clone = Object.create(Object.getPrototypeOf(expert)) as Expert;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(expert));
  Object.defineProperty(clone, "tools", {
    value: [...(expert.tools ?? []), tool],
    enumerable: true,
  });
  return clone;
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

async function updateInvocation(
  store: ExecutionStore,
  executionId: string,
  current: Invocation,
  patch: Partial<Invocation>,
): Promise<void> {
  const latest = await requireInvocation(store, executionId, current.invocationId);
  await store.putInvocation(executionId, {
    ...latest,
    ...patch,
    invocationId: current.invocationId,
    updatedAt: new Date().toISOString(),
  });
}

function projectOutput(event: {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}):
  | {
      readonly channel: "message" | "thought" | "tool" | "progress";
      readonly delta?: string;
      readonly value?: unknown;
    }
  | undefined {
  if (event.type === "message.delta")
    return { channel: "message", delta: String(event.payload["delta"] ?? "") };
  if (event.type === "message.completed")
    return { channel: "message", value: event.payload["text"] };
  if (event.type === "thought.delta")
    return { channel: "thought", delta: String(event.payload["delta"] ?? "") };
  if (event.type === "tool.delta")
    return { channel: "tool", delta: String(event.payload["delta"] ?? "") };
  if (event.type === "progress") return { channel: "progress", value: event.payload };
  return undefined;
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function serializeError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}

class DelegationLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}
