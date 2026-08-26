import { createHash, randomUUID } from "node:crypto";

import {
  InvocationOutputSchema,
  isTerminalExecutionStatus,
  type AgentInstance,
  type Invocation,
  type RuntimeContextRecord,
  type RuntimeContextOwner,
  type RuntimeEnvironmentBinding,
} from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import { fingerprintExpertExecutionDefinition } from "../agent/expert-definition-descriptor.ts";
import type { RuntimeModelSelection } from "../runtime/runtime-adapter.ts";
import { summarizeRuntimeInput } from "../runtime/output.ts";
import type { ExecutionStore } from "./execution-store.ts";
import {
  ExecutionFinalStatusConflictError,
  ExecutionVersionConflictError,
} from "./execution-store.ts";
import { getExecutionLiveBus } from "./execution-live-bus.ts";
import { InvocationService } from "./invocation-service.ts";
import {
  ContextResolutionService,
  type ContextResolutionScopeReader,
} from "./context-resolution-service.ts";
import type { ContextIdResolutionSource, ContextIdResolver } from "./context-id-resolver.ts";
import { defineContextIdResolver } from "./context-id-resolver.ts";

export interface DelegationPermit {
  suspend():
    | ((options?: {
        /** Re-enter a suspended control turn even while its child still occupies normal capacity. */
        readonly allowOvercommit?: boolean | undefined;
      }) => Promise<void>)
    | undefined;
  release(): void;
}

export interface ExpertInvocationJob {
  readonly agent: AgentInstance;
  readonly invocation: Invocation;
  readonly expert: Expert;
  readonly prompt: string;
  readonly permit: DelegationPermit;
}

export interface ExpertInterruptController {
  interruptInvocation(invocationId: string, reason?: string): Promise<boolean>;
  signalForInvocation(invocationId: string): AbortSignal;
  steerInvocation(request: {
    readonly invocationId: string;
    readonly contextId: string;
    readonly requestId: string;
    readonly content: string;
  }): Promise<"steered" | "waiting_continuation" | "not_active" | "unsupported">;
}

export interface ExpertInteractionAccess {
  readonly ownerContextId: string;
  readonly callerInvocationId: string;
  readonly callerAgentId?: string | undefined;
  readonly callerDepth: number;
  readonly spawnExpertIds: ReadonlySet<string>;
  readonly interactExpertIds: ReadonlySet<string>;
  readonly isCoordinator: boolean;
}

type ExpertWaitWake =
  | { readonly kind: "steer"; readonly requestId: string; readonly content: string }
  | { readonly kind: "message" };

export interface ExpertOrchestratorOptions {
  readonly executionId: string;
  readonly rootInvocationId: string;
  readonly scopeInvocationId: string;
  readonly store: ExecutionStore;
  readonly maxConcurrency: number;
  readonly maxDepth: number;
  readonly interruptController: ExpertInterruptController;
  readonly execute: (job: ExpertInvocationJob) => Promise<void>;
  readonly readContextScope?: ContextResolutionScopeReader | undefined;
  readonly persistContext?: ((context: RuntimeContextRecord) => Promise<void>) | undefined;
}

export class ExpertOrchestrator {
  private readonly semaphore: DelegationSemaphore;
  private readonly experts = new Map<string, Expert>();
  private readonly pumping = new Set<string>();
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly joinedInvocationIds = new Set<string>();
  private readonly steerWaiters = new Map<string, Set<(message: ExpertWaitWake) => boolean>>();

  constructor(private readonly options: ExpertOrchestratorOptions) {
    this.semaphore = new DelegationSemaphore(options.maxConcurrency);
  }

  get maxDepth(): number {
    return this.options.maxDepth;
  }

  async registerExperts(experts: readonly Expert[]): Promise<void> {
    for (const expert of experts) {
      const current = this.experts.get(expert.id);
      if (
        current !== undefined &&
        fingerprintExpertExecutionDefinition(current) !==
          fingerprintExpertExecutionDefinition(expert)
      ) {
        throw new Error(`Expert recovery definition mismatch: ${expert.id}.`);
      }
      this.experts.set(expert.id, expert);
    }
    await this.scheduleRecoverableAgents();
  }

  async spawn(request: {
    readonly ownerContextId: string;
    readonly createdByInvocationId: string;
    readonly parentAgentId?: string | undefined;
    readonly depth: number;
    readonly expert: Expert;
    readonly prompt: string;
    readonly runtime: RuntimeEnvironmentBinding;
    readonly modelSelection?: RuntimeModelSelection | undefined;
    readonly owner: RuntimeContextOwner;
    readonly resolver: ContextIdResolver;
    readonly source: ContextIdResolutionSource;
  }): Promise<{
    readonly agentId: string;
    readonly invocationId: string;
    readonly expertId: string;
    readonly contextId: string;
    readonly disposition: "created" | "reused";
    readonly agentDisposition: "reused" | "materialized";
    readonly status: "queued";
  }> {
    if (request.depth >= this.options.maxDepth) {
      throw new Error(`Expert delegation depth exceeded: ${this.options.maxDepth}`);
    }
    const invocationId = randomUUID();
    const definition = {
      id: request.expert.id,
      kind: "expert" as const,
    };
    const freshContextId = randomUUID();
    const invocations = new InvocationService(this.options.executionId, this.options.store);
    while (true) {
      const execution = await this.requireExecution();
      await this.requireActiveOwner(request.createdByInvocationId);
      const resolution = await new ContextResolutionService(
        this.options.store,
        this.options.readContextScope,
      ).resolve({
        executionId: this.options.executionId,
        invocationId,
        parentInvocationId: request.createdByInvocationId,
        input: request.prompt,
        state: execution.state,
        source: request.source,
        owner: request.owner,
        ownerContextId: request.ownerContextId,
        expert: { id: request.expert.id },
        runtime: request.runtime,
        modelSelection: request.modelSelection,
        resolver: request.resolver,
        freshContextId,
      });
      const currentAgents = await this.options.store.listAgents(this.options.executionId);
      const reusable = currentAgents.find(
        (agent) =>
          agent.contextId === resolution.context.contextId &&
          agent.ownerContextId === request.ownerContextId,
      );
      if (
        resolution.disposition === "reused" &&
        reusable === undefined &&
        !(resolution.contextPut !== undefined && this.options.readContextScope !== undefined)
      ) {
        throw new Error(
          `Runtime Context has no reusable AgentInstance: ${resolution.context.contextId}.`,
        );
      }
      if (reusable !== undefined && reusable.lifecycle !== "open") {
        throw new Error(`Agent is closed: ${reusable.agentId}`);
      }
      if (reusable !== undefined && reusable.definition.id !== definition.id) {
        throw new Error(
          `Agent identity conflicts with Runtime Context: ${resolution.context.contextId}.`,
        );
      }
      const agentId = reusable?.agentId ?? randomUUID();
      const taskSequence = reusable?.nextTaskSequence ?? 0;
      const now = new Date().toISOString();
      const agent: AgentInstance | undefined =
        reusable === undefined
          ? {
              schemaVersion: "pragma.agent-instance/v2",
              agentId,
              executionId: this.options.executionId,
              ownerContextId: request.ownerContextId,
              createdByInvocationId: request.createdByInvocationId,
              ...(request.parentAgentId === undefined
                ? {}
                : { parentAgentId: request.parentAgentId }),
              definition,
              contextId: resolution.context.contextId,
              lifecycle: "open",
              nextTaskSequence: 1,
              createdAt: now,
              updatedAt: now,
            }
          : undefined;
      const invocation: Invocation = {
        invocationId,
        rootInvocationId: this.options.rootInvocationId,
        parentInvocationId: request.createdByInvocationId,
        definition,
        executorId: request.expert.id,
        agentId,
        agentTaskSequence: taskSequence,
        contextId: resolution.context.contextId,
        contextResolution: {
          resolver: resolution.resolver,
          disposition: resolution.disposition,
        },
        status: "queued",
        pendingExpertMessages: [],
        input: request.prompt,
        createdAt: now,
        updatedAt: now,
      };
      try {
        assertWaitGraphAcyclic([
          ...(await this.options.store.listInvocations(this.options.executionId)),
          invocation,
        ]);
        await invocations.ensureQueued({
          commitId: `agent-dispatch:${invocationId}`,
          expectedVersion: execution.version,
          invocation,
          ...(agent === undefined ? {} : { agentPuts: [agent] }),
          ...(reusable === undefined
            ? {}
            : {
                agentPatches: [
                  { agentId, patch: { nextTaskSequence: reusable.nextTaskSequence + 1 } },
                ],
              }),
          ...(resolution.contextPut === undefined ? {} : { contextPuts: [resolution.contextPut] }),
          queuedData: {
            agentId,
            parentInvocationId: request.createdByInvocationId,
            taskSequence,
          },
          events: [
            ...resolution.events,
            {
              invocationId,
              type: reusable === undefined ? "agent.spawned" : "agent.reused",
              data: {
                agentId,
                expertId: request.expert.id,
                contextId: resolution.context.contextId,
              },
            },
          ],
        });
        await this.options.persistContext?.(resolution.context);
        this.experts.set(request.expert.id, request.expert);
        this.schedule(agentId);
        return {
          agentId,
          invocationId,
          contextId: resolution.context.contextId,
          expertId: request.expert.id,
          disposition: resolution.disposition,
          agentDisposition: reusable === undefined ? "materialized" : "reused",
          status: "queued",
        };
      } catch (error) {
        if (error instanceof ExecutionVersionConflictError) continue;
        throw error;
      }
    }
  }

  async continueContext(
    access: ExpertInteractionAccess,
    request: { readonly contextId: string; readonly task: string },
  ): Promise<{
    readonly contextId: string;
    readonly agentId: string;
    readonly invocationId: string;
    readonly agentDisposition: "reused" | "materialized";
    readonly status: "queued";
  }> {
    await this.requireActiveOwner(access.callerInvocationId);
    if (request.contextId === access.ownerContextId) {
      throw new Error("An Expert cannot continue its own current or root Runtime Context.");
    }
    const scope = await this.loadSessionScope();
    const context = scope.contexts.find((candidate) => candidate.contextId === request.contextId);
    if (context === undefined) {
      throw new Error(
        `Runtime Context is not available in this Team Session: ${request.contextId}.`,
      );
    }
    if (context.lifecycle !== "open") {
      throw new Error(`Runtime Context is closed: ${request.contextId}.`);
    }
    const historicalAgents = scope.agents
      .filter((agent) => agent.contextId === context.contextId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.agentId.localeCompare(right.agentId),
      );
    const currentAgent = historicalAgents.find(
      (agent) => agent.executionId === this.options.executionId,
    );
    const identityAgent = currentAgent ?? historicalAgents.at(-1);
    if (identityAgent === undefined || identityAgent.definition.id !== context.expert.id) {
      throw new Error(`Runtime Context has no compatible Expert Agent: ${request.contextId}.`);
    }
    if (!this.canAccessAgent(access, identityAgent)) {
      throw new Error(
        `Runtime Context is not accessible to the current Expert: ${request.contextId}.`,
      );
    }
    const expert = this.experts.get(context.expert.id);
    if (expert === undefined) {
      throw new Error(`Expert is not registered in this Team Session: ${context.expert.id}.`);
    }
    const ownerInvocation = await this.requireActiveOwner(access.callerInvocationId);
    const result = await this.spawn({
      ownerContextId: identityAgent.ownerContextId,
      createdByInvocationId: access.callerInvocationId,
      parentAgentId: access.callerAgentId,
      depth: access.callerDepth,
      expert,
      prompt: request.task,
      runtime: context.runtime,
      modelSelection: context.modelSelection,
      owner: context.owner,
      resolver: defineContextIdResolver({
        id: "pragma.context.expert-continuation",
        version: "v1",
        resolve: () => context.contextId,
      }),
      source: {
        kind: "expert-delegation",
        callerExpertId: ownerInvocation.executorId ?? ownerInvocation.definition.id,
        ...(ownerInvocation.agentId === undefined
          ? {}
          : { callerAgentId: ownerInvocation.agentId }),
      },
    });
    return {
      contextId: result.contextId,
      agentId: result.agentId,
      invocationId: result.invocationId,
      agentDisposition: result.agentDisposition,
      status: "queued",
    };
  }

  async list(
    access: ExpertInteractionAccess,
    request: {
      readonly expertId?: string | undefined;
      readonly status?: "running" | "waiting" | "queued" | "idle" | "resumable" | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): Promise<{
    readonly availableExperts: readonly unknown[];
    readonly contexts: readonly unknown[];
    readonly nextCursor?: string;
  }> {
    const limit = Math.min(100, Math.max(1, request.limit ?? 50));
    const scope = await this.loadSessionScope();
    const localAgentByContext = new Map(
      scope.agents
        .filter((agent) => agent.executionId === this.options.executionId)
        .map((agent) => [agent.contextId, agent]),
    );
    const historicalAgentByContext = new Map<string, AgentInstance>();
    for (const agent of scope.agents) {
      const previous = historicalAgentByContext.get(agent.contextId);
      if (
        previous === undefined ||
        previous.createdAt.localeCompare(agent.createdAt) < 0 ||
        (previous.createdAt === agent.createdAt &&
          previous.agentId.localeCompare(agent.agentId) < 0)
      ) {
        historicalAgentByContext.set(agent.contextId, agent);
      }
    }
    const directory = scope.contexts
      .filter((context) => context.contextId !== access.ownerContextId)
      .filter((context) => historicalAgentByContext.has(context.contextId))
      .filter((context) => request.expertId === undefined || context.expert.id === request.expertId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.contextId.localeCompare(right.contextId),
      );
    const cursorIndex =
      request.cursor === undefined
        ? -1
        : directory.findIndex((context) => context.contextId === request.cursor);
    if (request.cursor !== undefined && cursorIndex < 0) throw new Error("Invalid context cursor.");
    const entries = directory.map((context) => {
      const currentAgent = localAgentByContext.get(context.contextId);
      const identityAgent = currentAgent ?? historicalAgentByContext.get(context.contextId);
      const tasks =
        currentAgent === undefined
          ? []
          : scope.invocations
              .filter((invocation) => invocation.agentId === currentAgent.agentId)
              .sort(
                (left, right) =>
                  (left.agentTaskSequence ?? Number.MAX_SAFE_INTEGER) -
                    (right.agentTaskSequence ?? Number.MAX_SAFE_INTEGER) ||
                  left.createdAt.localeCompare(right.createdAt) ||
                  left.invocationId.localeCompare(right.invocationId),
              );
      const active = tasks.find(
        (invocation) => invocation.status === "running" || invocation.status === "waiting",
      );
      const queued = tasks.filter((invocation) => invocation.status === "queued");
      const latest = scope.invocations
        .filter((invocation) => invocation.contextId === context.contextId)
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.invocationId.localeCompare(right.invocationId),
        )
        .at(-1);
      const status =
        active?.status === "waiting"
          ? "waiting"
          : active
            ? "running"
            : queued.length > 0
              ? "queued"
              : currentAgent === undefined
                ? "resumable"
                : "idle";
      const canInteract =
        identityAgent !== undefined &&
        context.contextId !== access.ownerContextId &&
        context.lifecycle === "open" &&
        this.canAccessAgent(access, identityAgent);
      const canInterrupt =
        currentAgent !== undefined &&
        (access.isCoordinator || currentAgent.ownerContextId === access.ownerContextId) &&
        (active !== undefined || queued.length > 0);
      return {
        contextId: context.contextId,
        expertId: context.expert.id,
        scope: currentAgent === undefined ? "historical" : "current",
        status,
        ...(currentAgent === undefined ? {} : { agentId: currentAgent.agentId }),
        ...(active === undefined
          ? {}
          : {
              currentInvocation: {
                invocationId: active.invocationId,
                status: active.status,
                taskSummary: summarizeRuntimeInput(active.input, 240),
              },
            }),
        queuedInvocations: {
          total: queued.length,
          items: queued.slice(0, 20).map((invocation) => ({
            invocationId: invocation.invocationId,
            taskSummary: summarizeRuntimeInput(invocation.input, 240),
          })),
          truncated: queued.length > 20,
        },
        ...(latest === undefined || !isTerminalExecutionStatus(latest.status)
          ? {}
          : {
              recentTerminal: {
                invocationId: latest.invocationId,
                status: latest.status,
                ...(latest.output === undefined
                  ? {}
                  : { outputSummary: summarizeRuntimeInput(latest.output, 240) }),
                ...(latest.error === undefined
                  ? {}
                  : { errorSummary: summarizeRuntimeInput(latest.error, 240) }),
              },
            }),
        canContinue: canInteract,
        canSteerImmediate: canInteract && active !== undefined,
        canSteerNextBoundary: canInteract && active !== undefined,
        canInterrupt,
      };
    });
    const matching = entries.filter(
      (entry) => request.status === undefined || entry.status === request.status,
    );
    const matchingCursorIndex =
      request.cursor === undefined
        ? -1
        : matching.findIndex((entry) => entry.contextId === request.cursor);
    if (request.cursor !== undefined && matchingCursorIndex < 0) {
      throw new Error("Context cursor does not match the requested filters.");
    }
    const remaining = matching.slice(matchingCursorIndex + 1);
    const page = remaining.slice(0, limit);
    return {
      availableExperts: [...this.experts.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((expert) => ({
          expertId: expert.id,
          name: expert.name,
          description: expert.description,
          canSpawn: access.spawnExpertIds.has(expert.id),
        })),
      contexts: page,
      ...(remaining.length <= limit || page.length === 0
        ? {}
        : { nextCursor: page.at(-1)!.contextId }),
    };
  }

  async message(
    access: ExpertInteractionAccess,
    request: { readonly agentId: string; readonly invocationId: string; readonly message: string },
  ): Promise<{
    readonly messageId: string;
    readonly agentId: string;
    readonly invocationId: string;
    readonly status: "accepted";
    readonly delivery: "safe_boundary";
  }> {
    const messageId = randomUUID();
    while (true) {
      const execution = await this.requireExecution();
      const agent = await this.requireAccessibleAgent(access, request.agentId);
      if (agent.lifecycle !== "open") {
        throw new Error("agent_not_active: The Agent is closed.");
      }
      if (agent.activeInvocationId === undefined) {
        throw new Error("agent_not_active: The Agent has no active Invocation.");
      }
      if (agent.activeInvocationId !== request.invocationId) {
        throw new Error(
          `stale_invocation: expected ${request.invocationId}, current is ${agent.activeInvocationId}.`,
        );
      }
      const invocation = await this.options.store.getInvocation(
        this.options.executionId,
        request.invocationId,
      );
      if (
        invocation === undefined ||
        invocation.agentId !== agent.agentId ||
        isTerminalExecutionStatus(invocation.status)
      ) {
        throw new Error("stale_invocation: The target Invocation is no longer active.");
      }
      const envelope = {
        messageId,
        senderInvocationId: access.callerInvocationId,
        ...(access.callerAgentId === undefined ? {} : { senderAgentId: access.callerAgentId }),
        content: request.message,
        createdAt: new Date().toISOString(),
      };
      try {
        await this.options.store.commit({
          commitId: `expert-message-accepted:${messageId}`,
          executionId: this.options.executionId,
          expectedVersion: execution.version,
          invocationPatches: [
            {
              invocationId: invocation.invocationId,
              patch: {
                pendingExpertMessages: [...invocation.pendingExpertMessages, envelope],
              },
            },
          ],
          events: [
            {
              invocationId: invocation.invocationId,
              type: "expert.message.accepted",
              data: {
                ...envelope,
                agentId: agent.agentId,
                targetInvocationId: invocation.invocationId,
              },
            },
          ],
        });
        this.wakeWait(agent.contextId, { kind: "message" });
        return {
          messageId,
          agentId: agent.agentId,
          invocationId: invocation.invocationId,
          status: "accepted",
          delivery: "safe_boundary",
        };
      } catch (error) {
        if (error instanceof ExecutionVersionConflictError) continue;
        throw error;
      }
    }
  }

  async readPendingMessages(invocationId: string): Promise<Invocation["pendingExpertMessages"]> {
    const invocation = await this.options.store.getInvocation(
      this.options.executionId,
      invocationId,
    );
    if (invocation === undefined) throw new Error(`Invocation not found: ${invocationId}`);
    return invocation.pendingExpertMessages;
  }

  async acknowledgePendingMessages(
    invocationId: string,
    messageIds: readonly string[],
    terminalReason?: string,
  ): Promise<void> {
    const requestedIds = new Set(messageIds);
    if (requestedIds.size === 0) return;
    while (true) {
      const execution = await this.requireExecution();
      const invocation = await this.options.store.getInvocation(
        this.options.executionId,
        invocationId,
      );
      if (invocation === undefined) throw new Error(`Invocation not found: ${invocationId}`);
      const messages = invocation.pendingExpertMessages.filter((message) =>
        requestedIds.has(message.messageId),
      );
      if (messages.length === 0) return;
      const acknowledgedIds = messages.map((message) => message.messageId);
      try {
        await this.options.store.commit({
          commitId: `expert-messages-consumed:${invocationId}:${createHash("sha256")
            .update(acknowledgedIds.join("\0"))
            .digest("hex")}`,
          executionId: this.options.executionId,
          expectedVersion: execution.version,
          invocationPatches: [
            {
              invocationId,
              patch: {
                pendingExpertMessages: invocation.pendingExpertMessages.filter(
                  (message) => !requestedIds.has(message.messageId),
                ),
              },
            },
          ],
          events: [
            {
              invocationId,
              type: "expert.message.consumed",
              data: {
                messageIds: acknowledgedIds,
                ...(terminalReason === undefined ? {} : { terminalReason }),
              },
            },
          ],
        });
        return;
      } catch (error) {
        if (error instanceof ExecutionVersionConflictError) continue;
        throw error;
      }
    }
  }

  async steer(
    access: ExpertInteractionAccess,
    request: {
      readonly invocationId: string;
      readonly instruction: string;
      readonly delivery: "next_boundary" | "immediate";
    },
  ): Promise<unknown> {
    const requestedInvocation = await this.options.store.getInvocation(
      this.options.executionId,
      request.invocationId,
    );
    if (requestedInvocation?.agentId === undefined) {
      throw new Error(`Invocation is not an Expert task: ${request.invocationId}.`);
    }
    const agent = await this.requireAccessibleAgent(access, requestedInvocation.agentId);
    if (agent.lifecycle !== "open") throw new Error(`Agent is closed: ${agent.agentId}`);
    const activeInvocationId = agent.activeInvocationId;
    if (request.invocationId !== activeInvocationId) {
      throw new Error(
        `Stale steer target: expected ${request.invocationId}, current is ${activeInvocationId ?? "idle"}.`,
      );
    }
    if (activeInvocationId === undefined) {
      throw new Error("agent_not_active: The Agent has no active Invocation.");
    }
    const active = await this.options.store.getInvocation(
      this.options.executionId,
      activeInvocationId,
    );
    if (active === undefined || isTerminalExecutionStatus(active.status)) {
      throw new Error("stale_invocation: The target Invocation is no longer active.");
    }
    if (request.delivery === "next_boundary") {
      const accepted = await this.message(access, {
        agentId: agent.agentId,
        invocationId: active.invocationId,
        message: request.instruction,
      });
      return {
        outcome: "accepted",
        delivery: "next_boundary",
        messageId: accepted.messageId,
        contextId: agent.contextId,
        agentId: agent.agentId,
        invocationId: active.invocationId,
      };
    }
    const requestId = randomUUID();
    await this.options.store.appendEvent(
      this.options.executionId,
      active.invocationId,
      "agent.steer.requested",
      {
        requestId,
        callerInvocationId: access.callerInvocationId,
        callerAgentId: access.callerAgentId,
        agentId: agent.agentId,
        message: request.instruction,
      },
      `agent-steer-requested:${requestId}`,
    );
    const outcome = await this.options.interruptController.steerInvocation({
      invocationId: active.invocationId,
      contextId: agent.contextId,
      requestId,
      content: request.instruction,
    });
    if (outcome === "steered" || outcome === "waiting_continuation") {
      await this.options.store.appendEvent(
        this.options.executionId,
        active.invocationId,
        "agent.steer.applied",
        { requestId, agentId: agent.agentId, mode: outcome, content: request.instruction },
        `agent-steer-applied:${requestId}`,
      );
      return {
        outcome: "steered",
        mode: outcome === "steered" ? "runtime" : "waiting_continuation",
        delivery: "immediate",
        contextId: agent.contextId,
        agentId: agent.agentId,
        invocationId: active.invocationId,
      };
    }
    const reason = outcome === "unsupported" ? "runtime_unsupported" : "turn_not_active";
    await this.options.store.appendEvent(
      this.options.executionId,
      active.invocationId,
      "agent.steer.rejected",
      { requestId, agentId: agent.agentId, reason },
      `agent-steer-rejected:${requestId}`,
    );
    throw new Error(`Expert steering rejected: ${reason}.`);
  }

  async wait(
    access: ExpertInteractionAccess,
    request: {
      readonly invocationIds: readonly string[];
      readonly returnWhen?: "all" | "any" | undefined;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    },
    permit?: DelegationPermit,
  ): Promise<{
    readonly returnWhen: "all" | "any";
    readonly timedOut: boolean;
    readonly completed: readonly unknown[];
    readonly pending: readonly unknown[];
    readonly wakeReason?: "steer" | "message" | undefined;
    readonly steer?: { readonly requestId: string; readonly content: string } | undefined;
  }> {
    await this.assertAccessibleInvocations(access, request.invocationIds);
    const resume = permit?.suspend();
    let hasPendingWork = true;
    try {
      const result = await this.waitForInvocations(
        access.ownerContextId,
        access.callerInvocationId,
        request,
      );
      for (const completed of result.completed) {
        this.joinedInvocationIds.add((completed as { invocationId: string }).invocationId);
      }
      hasPendingWork = result.pending.length > 0;
      return result;
    } finally {
      await resume?.({ allowOvercommit: hasPendingWork });
    }
  }

  async waitForOwnedUnjoined(
    ownerInvocationId: string,
    access: ExpertInteractionAccess,
    signal: AbortSignal,
    permit?: DelegationPermit,
    timeoutMs?: number,
  ): Promise<{
    readonly timedOut: boolean;
    readonly completed: readonly unknown[];
    readonly pending: readonly unknown[];
    readonly wakeReason?: "steer" | "message" | undefined;
    readonly steer?: { readonly requestId: string; readonly content: string } | undefined;
  }> {
    const agents = await this.loadScopedAgents();
    const allInvocations = await this.options.store.listInvocations(this.options.executionId);
    const ids = allInvocations
      .filter(
        (invocation) =>
          invocation.parentInvocationId === ownerInvocationId &&
          agents.some((agent) => agent.agentId === invocation.agentId),
      )
      .filter((invocation) => !this.joinedInvocationIds.has(invocation.invocationId))
      .map((invocation) => invocation.invocationId);
    if (ids.length === 0) return { timedOut: false, completed: [], pending: [] };
    const result = await this.wait(
      access,
      { invocationIds: ids, returnWhen: "all", signal, timeoutMs },
      permit,
    );
    return result;
  }

  wakeWait(ownerContextId: string, message: ExpertWaitWake): boolean {
    const waiters = this.steerWaiters.get(ownerContextId);
    if (waiters === undefined || waiters.size === 0) return false;
    return [...waiters].some((wake) => wake(message));
  }

  async hasOwnedUnjoined(ownerInvocationId: string): Promise<boolean> {
    const agents = await this.loadScopedAgents();
    if (agents.length === 0) return false;
    const ids = new Set(agents.map((agent) => agent.agentId));
    const invocations = await this.options.store.listInvocations(this.options.executionId);
    return invocations.some(
      (invocation) =>
        invocation.parentInvocationId === ownerInvocationId &&
        invocation.agentId !== undefined &&
        ids.has(invocation.agentId) &&
        !this.joinedInvocationIds.has(invocation.invocationId),
    );
  }

  async interrupt(
    access: ExpertInteractionAccess,
    request: {
      readonly invocationId: string;
      readonly reason?: string | undefined;
    },
  ): Promise<{
    readonly contextId: string;
    readonly agentId: string;
    readonly invocationId: string;
    readonly outcome: "interrupted" | "cancelled" | "already_terminal";
  }> {
    while (true) {
      const invocation = await this.options.store.getInvocation(
        this.options.executionId,
        request.invocationId,
      );
      if (invocation?.agentId === undefined) {
        throw new Error(`Invocation is not an Expert task: ${request.invocationId}.`);
      }
      const agent = access.isCoordinator
        ? await this.requireAccessibleAgent(access, invocation.agentId)
        : await this.requireOwnedAgent(access.ownerContextId, invocation.agentId);
      if (isTerminalExecutionStatus(invocation.status)) {
        return {
          invocationId: invocation.invocationId,
          agentId: agent.agentId,
          contextId: agent.contextId,
          outcome: "already_terminal",
        };
      }
      if (invocation.status === "queued") {
        const outcome = await this.cancelQueuedInvocation(invocation, request.reason);
        if (outcome === "active") continue;
        this.schedule(agent.agentId);
        return {
          invocationId: invocation.invocationId,
          agentId: agent.agentId,
          contextId: agent.contextId,
          outcome,
        };
      }
      if (agent.activeInvocationId !== invocation.invocationId) {
        continue;
      }
      const interrupted = await this.options.interruptController.interruptInvocation(
        invocation.invocationId,
        request.reason,
      );
      if (!interrupted) {
        const latest = await this.options.store.getInvocation(
          this.options.executionId,
          invocation.invocationId,
        );
        if (latest === undefined) {
          throw new Error(`Invocation not found: ${invocation.invocationId}.`);
        }
        if (!isTerminalExecutionStatus(latest.status)) {
          throw new Error(
            `Invocation could not be interrupted while still active: ${invocation.invocationId}.`,
          );
        }
        return {
          invocationId: latest.invocationId,
          agentId: agent.agentId,
          contextId: agent.contextId,
          outcome: "already_terminal",
        };
      }
      this.schedule(agent.agentId);
      return {
        invocationId: invocation.invocationId,
        agentId: agent.agentId,
        contextId: agent.contextId,
        outcome: "interrupted",
      };
    }
  }

  async interruptOwned(ownerInvocationId: string, reason: string): Promise<void> {
    while (true) {
      const invocations = await this.options.store.listInvocations(this.options.executionId);
      const descendantIds = collectDescendantInvocationIds(invocations, ownerInvocationId);
      const active = invocations.filter(
        (invocation) =>
          descendantIds.has(invocation.invocationId) &&
          !isTerminalExecutionStatus(invocation.status),
      );
      for (const invocation of active) {
        await this.options.interruptController.interruptInvocation(invocation.invocationId, reason);
      }
      const running = [...descendantIds].flatMap((invocationId) => {
        const job = this.activeJobs.get(invocationId);
        return job === undefined ? [] : [job];
      });
      if (running.length > 0) {
        const results = await Promise.allSettled(running);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Descendant Expert jobs failed to become idle.");
        }
        continue;
      }
      if (active.length === 0) return;
    }
  }

  private async cancelQueuedInvocation(
    invocation: Invocation,
    reason?: string,
  ): Promise<"cancelled" | "already_terminal" | "active"> {
    while (true) {
      const execution = await this.requireExecution();
      const current = await this.options.store.getInvocation(
        this.options.executionId,
        invocation.invocationId,
      );
      if (current === undefined) {
        throw new Error(`Invocation not found: ${invocation.invocationId}.`);
      }
      if (isTerminalExecutionStatus(current.status)) return "already_terminal";
      if (current.status !== "queued") {
        return "active";
      }
      try {
        await this.options.store.commit({
          commitId: `invocation-cancelled:${current.invocationId}`,
          executionId: this.options.executionId,
          expectedVersion: execution.version,
          invocationPatches: [
            {
              invocationId: current.invocationId,
              patch: {
                status: "cancelled",
                pendingExpertMessages: [],
                ...(reason === undefined ? {} : { error: reason }),
              },
            },
          ],
          events: [
            ...(current.pendingExpertMessages.length === 0
              ? []
              : [
                  {
                    invocationId: current.invocationId,
                    type: "expert.message.consumed",
                    data: {
                      messageIds: current.pendingExpertMessages.map((message) => message.messageId),
                      terminalReason: "cancelled",
                    },
                  },
                ]),
            {
              invocationId: current.invocationId,
              type: "invocation.cancelled",
              data: { reason },
            },
          ],
        });
        return "cancelled";
      } catch (error) {
        if (error instanceof ExecutionVersionConflictError) continue;
        if (error instanceof ExecutionFinalStatusConflictError) return "already_terminal";
        throw error;
      }
    }
  }

  private schedule(agentId: string): void {
    if (this.pumping.has(agentId)) return;
    this.pumping.add(agentId);
    void this.pump(agentId).finally(() => {
      this.pumping.delete(agentId);
      void this.rescheduleIfQueued(agentId);
    });
  }

  private async rescheduleIfQueued(agentId: string): Promise<void> {
    const queued = (await this.options.store.listInvocations(this.options.executionId)).some(
      (invocation) => invocation.agentId === agentId && invocation.status === "queued",
    );
    if (queued) this.schedule(agentId);
  }

  private async pump(agentId: string): Promise<void> {
    while (true) {
      const agent = await this.options.store.getAgent(this.options.executionId, agentId);
      if (agent === undefined || agent.lifecycle !== "open") return;
      const next = (await this.options.store.listInvocations(this.options.executionId))
        .filter((invocation) => invocation.agentId === agentId && invocation.status === "queued")
        .sort((left, right) => (left.agentTaskSequence ?? 0) - (right.agentTaskSequence ?? 0))[0];
      if (next === undefined) return;
      const expert = this.experts.get(agent.definition.id);
      if (expert === undefined) {
        await this.failUnrecoverableJob(next, "Agent task Expert definition is unavailable.");
        continue;
      }
      const context = await this.options.store.getContext(
        this.options.executionId,
        agent.contextId,
      );
      if (context === undefined) {
        await this.failUnrecoverableJob(next, "Agent task Runtime Context is unavailable.");
        continue;
      }
      const permit = await this.semaphore.acquire();
      const latest = await this.options.store.getInvocation(
        this.options.executionId,
        next.invocationId,
      );
      if (latest === undefined || latest.status !== "queued") {
        permit.release();
        continue;
      }
      const running = this.executeActiveJob({
        agentId,
        invocation: latest,
        expert,
        prompt: String(latest.input),
        permit,
      });
      this.activeJobs.set(next.invocationId, running);
      try {
        await running;
      } finally {
        if (this.activeJobs.get(next.invocationId) === running) {
          this.activeJobs.delete(next.invocationId);
        }
      }
    }
  }

  private async executeActiveJob(options: {
    readonly agentId: string;
    readonly invocation: Invocation;
    readonly expert: Expert;
    readonly prompt: string;
    readonly permit: DelegationPermit;
  }): Promise<void> {
    try {
      await this.options.store.commit({
        commitId: `agent-activated:${options.invocation.invocationId}:${randomUUID()}`,
        executionId: this.options.executionId,
        agentPatches: [
          {
            agentId: options.agentId,
            patch: { activeInvocationId: options.invocation.invocationId },
          },
        ],
        events: [
          {
            invocationId: options.invocation.invocationId,
            type: "agent.task.activated",
            data: { agentId: options.agentId },
          },
        ],
      });
      const activeAgent = (await this.options.store.getAgent(
        this.options.executionId,
        options.agentId,
      ))!;
      await this.options.execute({
        agent: activeAgent,
        invocation: options.invocation,
        expert: options.expert,
        prompt: options.prompt,
        permit: options.permit,
      });
    } catch {
      const current = await this.options.store.getInvocation(
        this.options.executionId,
        options.invocation.invocationId,
      );
      if (current !== undefined && !isTerminalExecutionStatus(current.status)) {
        await this.failUnrecoverableJob(
          current,
          "Expert task failed before reaching a terminal state.",
        );
      }
    } finally {
      try {
        const currentAgent = await this.options.store.getAgent(
          this.options.executionId,
          options.agentId,
        );
        if (currentAgent?.activeInvocationId === options.invocation.invocationId) {
          await this.options.store.commit({
            commitId: `agent-idle:${options.invocation.invocationId}`,
            executionId: this.options.executionId,
            agentPatches: [{ agentId: options.agentId, patch: { activeInvocationId: undefined } }],
            events: [
              {
                invocationId: options.invocation.invocationId,
                type: "agent.task.released",
                data: { agentId: options.agentId },
              },
            ],
          });
        }
      } finally {
        options.permit.release();
      }
    }
  }

  private async waitForInvocations(
    ownerContextId: string,
    ownerInvocationId: string,
    request: {
      readonly invocationIds: readonly string[];
      readonly returnWhen?: "all" | "any" | undefined;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<{
    readonly returnWhen: "all" | "any";
    readonly timedOut: boolean;
    readonly completed: readonly unknown[];
    readonly pending: readonly unknown[];
    readonly wakeReason?: "steer" | "message" | undefined;
    readonly steer?: { readonly requestId: string; readonly content: string } | undefined;
  }> {
    const returnWhen = request.returnWhen ?? "all";
    const subscription = getExecutionLiveBus(this.options.store).subscribeEvents(
      this.options.executionId,
    );
    const iterator = subscription[Symbol.asyncIterator]();
    const deadline = request.timeoutMs === undefined ? undefined : Date.now() + request.timeoutMs;
    let wakeMessage: ExpertWaitWake | undefined;
    let resolveSteer: (() => void) | undefined;
    const steerSignal = new Promise<void>((resolve) => {
      resolveSteer = resolve;
    });
    const wake = (message: ExpertWaitWake) => {
      if (wakeMessage !== undefined) return false;
      wakeMessage = message;
      resolveSteer?.();
      return true;
    };
    const waiters = this.steerWaiters.get(ownerContextId) ?? new Set();
    waiters.add(wake);
    this.steerWaiters.set(ownerContextId, waiters);
    try {
      while (true) {
        if (request.signal?.aborted) throw new Error("wait_experts was cancelled.");
        const invocations = await this.loadInvocations(request.invocationIds);
        const completed = invocations.filter((invocation) =>
          isTerminalExecutionStatus(invocation.status),
        );
        const conditionMet =
          returnWhen === "all" ? completed.length === invocations.length : completed.length > 0;
        const timedOut = deadline !== undefined && Date.now() >= deadline;
        const ownerInvocation = await this.options.store.getInvocation(
          this.options.executionId,
          ownerInvocationId,
        );
        const hasPendingMessage = (ownerInvocation?.pendingExpertMessages.length ?? 0) > 0;
        if (conditionMet || timedOut || wakeMessage !== undefined || hasPendingMessage) {
          waiters.delete(wake);
          if (waiters.size === 0) this.steerWaiters.delete(ownerContextId);
          return {
            returnWhen,
            timedOut: !conditionMet && timedOut,
            completed: completed.map(summarizeInvocation),
            pending: invocations
              .filter((invocation) => !isTerminalExecutionStatus(invocation.status))
              .map(summarizeInvocation),
            ...(wakeMessage === undefined && !hasPendingMessage
              ? {}
              : wakeMessage?.kind === "steer"
                ? { wakeReason: "steer" as const, steer: wakeMessage }
                : { wakeReason: "message" as const }),
          };
        }
        await Promise.race([waitForEvent(iterator, deadline, request.signal), steerSignal]);
      }
    } finally {
      waiters.delete(wake);
      if (waiters.size === 0) this.steerWaiters.delete(ownerContextId);
      await subscription.close();
    }
  }

  private async assertAccessibleInvocations(
    access: ExpertInteractionAccess,
    invocationIds: readonly string[],
  ): Promise<void> {
    const invocations = await this.loadInvocations(invocationIds);
    const agents = new Map((await this.loadScopedAgents()).map((agent) => [agent.agentId, agent]));
    for (const invocation of invocations) {
      const agent = invocation.agentId === undefined ? undefined : agents.get(invocation.agentId);
      if (
        agent === undefined ||
        invocation.parentInvocationId !== access.callerInvocationId ||
        !this.canAccessAgent(access, agent)
      ) {
        throw new Error(
          `Invocation is not accessible to the current Expert: ${invocation.invocationId}`,
        );
      }
    }
  }

  private async loadInvocations(ids: readonly string[]): Promise<Invocation[]> {
    const byId = new Map(
      (await this.options.store.listInvocations(this.options.executionId)).map((invocation) => [
        invocation.invocationId,
        invocation,
      ]),
    );
    return ids.map((id) => {
      const invocation = byId.get(id);
      if (invocation === undefined) throw new Error(`Invocation not found: ${id}`);
      return invocation;
    });
  }

  private canAccessAgent(access: ExpertInteractionAccess, agent: AgentInstance): boolean {
    return (
      access.isCoordinator ||
      agent.ownerContextId === access.ownerContextId ||
      access.interactExpertIds.has(agent.definition.id)
    );
  }

  private async loadScopedAgents(): Promise<AgentInstance[]> {
    const invocations = await this.options.store.listInvocations(this.options.executionId);
    const creators = collectDescendantInvocationIds(invocations, this.options.scopeInvocationId);
    creators.add(this.options.scopeInvocationId);
    return (await this.options.store.listAgents(this.options.executionId)).filter((agent) =>
      creators.has(agent.createdByInvocationId),
    );
  }

  private async loadSessionScope(): Promise<{
    readonly contexts: RuntimeContextRecord[];
    readonly invocations: Invocation[];
    readonly agents: AgentInstance[];
  }> {
    const [localContexts, localInvocations, localAgents, sessionScope] = await Promise.all([
      this.options.store.listContexts(this.options.executionId),
      this.options.store.listInvocations(this.options.executionId),
      this.options.store.listAgents(this.options.executionId),
      this.options.readContextScope?.(),
    ]);
    return {
      contexts: mergeByIdentity(
        sessionScope?.contexts ?? [],
        localContexts,
        (context) => context.contextId,
      ),
      invocations: mergeByIdentity(
        sessionScope?.invocations ?? [],
        localInvocations,
        (invocation) => invocation.invocationId,
      ),
      agents: mergeByIdentity(sessionScope?.agents ?? [], localAgents, (agent) => agent.agentId),
    };
  }

  private async requireAccessibleAgent(
    access: ExpertInteractionAccess,
    agentId: string,
  ): Promise<AgentInstance> {
    const agent = (await this.loadScopedAgents()).find(
      (candidate) => candidate.agentId === agentId,
    );
    if (agent === undefined || !this.canAccessAgent(access, agent)) {
      throw new Error(`Agent is not accessible to the current Expert: ${agentId}`);
    }
    if (access.callerAgentId !== undefined && agent.agentId === access.callerAgentId) {
      throw new Error(`An Agent cannot interact with itself: ${agentId}`);
    }
    return agent;
  }

  private async requireOwnedAgent(ownerContextId: string, agentId: string): Promise<AgentInstance> {
    const agent = (await this.loadScopedAgents()).find(
      (candidate) => candidate.agentId === agentId,
    );
    if (agent === undefined || agent.ownerContextId !== ownerContextId) {
      throw new Error(`Agent is not owned by the current Expert: ${agentId}`);
    }
    return agent;
  }

  private async requireActiveOwner(ownerInvocationId: string): Promise<Invocation> {
    const owner = await this.options.store.getInvocation(
      this.options.executionId,
      ownerInvocationId,
    );
    if (owner === undefined) throw new Error(`Owner Invocation not found: ${ownerInvocationId}`);
    if (isTerminalExecutionStatus(owner.status)) {
      throw new Error(`Owner Invocation is terminal: ${ownerInvocationId}`);
    }
    return owner;
  }

  private async requireExecution() {
    const execution = await this.options.store.get(this.options.executionId);
    if (execution === undefined)
      throw new Error(`Execution not found: ${this.options.executionId}`);
    return execution;
  }

  private async failUnrecoverableJob(invocation: Invocation, message: string): Promise<void> {
    while (true) {
      const execution = await this.requireExecution();
      const current = await this.options.store.getInvocation(
        this.options.executionId,
        invocation.invocationId,
      );
      if (current === undefined || isTerminalExecutionStatus(current.status)) return;
      const agent =
        current.agentId === undefined
          ? undefined
          : await this.options.store.getAgent(this.options.executionId, current.agentId);
      try {
        await this.options.store.commit({
          commitId: `agent-failed:${current.invocationId}`,
          executionId: this.options.executionId,
          expectedVersion: execution.version,
          invocationPatches: [
            {
              invocationId: current.invocationId,
              patch: {
                status: "failed",
                waitReason: undefined,
                pendingExpertMessages: [],
                error: { message },
              },
            },
          ],
          ...(agent?.activeInvocationId === current.invocationId
            ? {
                agentPatches: [
                  { agentId: agent.agentId, patch: { activeInvocationId: undefined } },
                ],
              }
            : {}),
          events: [
            ...(current.pendingExpertMessages.length === 0
              ? []
              : [
                  {
                    invocationId: current.invocationId,
                    type: "expert.message.consumed",
                    data: {
                      messageIds: current.pendingExpertMessages.map(
                        (pendingMessage) => pendingMessage.messageId,
                      ),
                      terminalReason: "unrecoverable",
                    },
                  },
                ]),
            { invocationId: current.invocationId, type: "invocation.failed", data: { message } },
          ],
        });
        return;
      } catch (error) {
        if (error instanceof ExecutionVersionConflictError) continue;
        if (error instanceof ExecutionFinalStatusConflictError) return;
        throw error;
      }
    }
  }

  private async scheduleRecoverableAgents(): Promise<void> {
    for (const agent of await this.loadScopedAgents()) {
      if (agent.lifecycle !== "open" || !this.experts.has(agent.definition.id)) continue;
      if (
        agent.activeInvocationId !== undefined &&
        !this.activeJobs.has(agent.activeInvocationId)
      ) {
        while (true) {
          const execution = await this.requireExecution();
          const currentAgent = await this.options.store.getAgent(
            this.options.executionId,
            agent.agentId,
          );
          if (currentAgent?.activeInvocationId === undefined) break;
          const invocation = await this.options.store.getInvocation(
            this.options.executionId,
            currentAgent.activeInvocationId,
          );
          try {
            await this.options.store.commit({
              commitId: `agent-recovered:${currentAgent.activeInvocationId}`,
              executionId: this.options.executionId,
              expectedVersion: execution.version,
              ...(invocation === undefined || isTerminalExecutionStatus(invocation.status)
                ? {}
                : {
                    invocationPatches: [
                      {
                        invocationId: invocation.invocationId,
                        patch: { status: "queued", waitReason: undefined },
                      },
                    ],
                  }),
              agentPatches: [
                { agentId: currentAgent.agentId, patch: { activeInvocationId: undefined } },
              ],
              events: [
                {
                  invocationId: currentAgent.activeInvocationId,
                  type: "agent.task.recovered",
                  data: { agentId: currentAgent.agentId },
                },
              ],
            });
            break;
          } catch (error) {
            if (error instanceof ExecutionVersionConflictError) continue;
            throw error;
          }
        }
      }
      this.schedule(agent.agentId);
    }
  }
}

/** @internal Exported for deterministic liveness tests; not part of the package public API. */
export class DelegationSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<DelegationPermit> {
    await this.acquireSlot(false);
    let held = true;
    return {
      suspend: () => {
        if (!held) return undefined;
        held = false;
        this.releaseSlot();
        return async (options) => {
          if (held) return;
          await this.acquireSlot(options?.allowOvercommit === true);
          held = true;
        };
      },
      release: () => {
        if (!held) return;
        held = false;
        this.releaseSlot();
      },
    };
  }

  private async acquireSlot(allowOvercommit: boolean): Promise<void> {
    if (this.active >= this.limit) {
      if (allowOvercommit) {
        this.active += 1;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      return;
    }
    this.active += 1;
  }

  private releaseSlot(): void {
    if (this.active < 1) throw new Error("Delegation concurrency slot underflow.");
    this.active -= 1;
    if (this.active >= this.limit) return;
    const next = this.waiters.shift();
    if (next === undefined) return;
    this.active += 1;
    next();
  }
}

function collectDescendantInvocationIds(
  invocations: readonly Invocation[],
  ownerInvocationId: string,
): Set<string> {
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const invocation of invocations) {
      if (
        invocation.parentInvocationId !== undefined &&
        (invocation.parentInvocationId === ownerInvocationId ||
          descendants.has(invocation.parentInvocationId)) &&
        !descendants.has(invocation.invocationId)
      ) {
        descendants.add(invocation.invocationId);
        changed = true;
      }
    }
  }
  return descendants;
}

function assertWaitGraphAcyclic(invocations: readonly Invocation[]): void {
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    const targets = edges.get(from) ?? new Set<string>();
    targets.add(to);
    edges.set(from, targets);
  };
  for (const invocation of invocations) {
    if (
      invocation.parentInvocationId !== undefined &&
      !isTerminalExecutionStatus(invocation.status)
    ) {
      addEdge(invocation.parentInvocationId, invocation.invocationId);
    }
  }
  const byAgent = new Map<string, Invocation[]>();
  for (const invocation of invocations) {
    if (invocation.agentId === undefined || invocation.agentTaskSequence === undefined) continue;
    const tasks = byAgent.get(invocation.agentId) ?? [];
    tasks.push(invocation);
    byAgent.set(invocation.agentId, tasks);
  }
  for (const tasks of byAgent.values()) {
    const active = tasks
      .filter((task) => !isTerminalExecutionStatus(task.status))
      .sort((left, right) => left.agentTaskSequence! - right.agentTaskSequence!);
    for (let index = 1; index < active.length; index += 1) {
      addEdge(active[index]!.invocationId, active[index - 1]!.invocationId);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (invocationId: string): string[] | undefined => {
    if (visiting.has(invocationId)) {
      const start = path.indexOf(invocationId);
      return [...path.slice(start), invocationId];
    }
    if (visited.has(invocationId)) return undefined;
    visiting.add(invocationId);
    path.push(invocationId);
    for (const target of edges.get(invocationId) ?? []) {
      const cycle = visit(target);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    visiting.delete(invocationId);
    visited.add(invocationId);
    return undefined;
  };
  for (const invocation of invocations) {
    const cycle = visit(invocation.invocationId);
    if (cycle !== undefined) {
      throw new Error(`expert_wait_cycle: ${cycle.join(" -> ")}`);
    }
  }
}

function summarizeInvocation(invocation: Invocation): unknown {
  const output = InvocationOutputSchema.safeParse(invocation.output);
  return {
    agentId: invocation.agentId,
    invocationId: invocation.invocationId,
    contextId: invocation.contextId,
    status: invocation.status,
    ...(output.success
      ? output.data.type === "inline"
        ? { output: output.data.value }
        : { output: output.data }
      : invocation.output === undefined
        ? {}
        : { output: invocation.output }),
    ...(invocation.error === undefined ? {} : { error: invocation.error }),
    ...(invocation.usage === undefined ? {} : { usage: invocation.usage }),
  };
}

function mergeByIdentity<TValue>(
  first: readonly TValue[],
  second: readonly TValue[],
  readId: (value: TValue) => string,
): TValue[] {
  const values = new Map(first.map((value) => [readId(value), value]));
  for (const value of second) values.set(readId(value), value);
  return [...values.values()];
}

async function waitForEvent(
  iterator: AsyncIterator<unknown>,
  deadline: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const waits: Promise<unknown>[] = [iterator.next()];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  if (deadline !== undefined) {
    waits.push(
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      }),
    );
  }
  if (signal !== undefined) {
    waits.push(
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else {
          abortHandler = resolve;
          signal.addEventListener("abort", abortHandler, { once: true });
        }
      }),
    );
  }
  try {
    await Promise.race(waits);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortHandler !== undefined) signal?.removeEventListener("abort", abortHandler);
  }
}
