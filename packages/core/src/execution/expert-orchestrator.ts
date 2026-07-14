import { randomUUID } from "node:crypto";

import {
  isTerminalExecutionStatus,
  type AgentInstance,
  type Invocation,
  type RuntimeContextRecord,
  type RuntimeContextOwner,
} from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import type { ExecutionStore } from "./execution-store.ts";
import { ExecutionVersionConflictError } from "./execution-store.ts";
import { getExecutionLiveBus } from "./execution-live-bus.ts";
import { InvocationService } from "./invocation-service.ts";
import {
  ContextResolutionService,
  type ContextResolutionScopeReader,
} from "./context-resolution-service.ts";
import type { ContextIdResolutionSource, ContextIdResolver } from "./context-id-resolver.ts";
import { defineContextIdResolver } from "./context-id-resolver.ts";

const followupContextIdResolver = defineContextIdResolver({
  id: "pragma.context.agent-followup",
  version: "v1",
  resolve: ({ freshContextId }) => freshContextId,
});

export interface DelegationPermit {
  suspend(): (() => Promise<void>) | undefined;
  release(): void;
}

export interface ExpertInvocationJob {
  readonly agent: AgentInstance;
  readonly invocation: Invocation;
  readonly expert: Expert;
  readonly prompt: string;
  readonly runtimeId?: string | undefined;
  readonly permit: DelegationPermit;
}

export interface ExpertInterruptController {
  interruptInvocation(invocationId: string, reason?: string): Promise<boolean>;
  signalForInvocation(invocationId: string): AbortSignal;
}

export interface ExpertOrchestratorOptions {
  readonly executionId: string;
  readonly rootInvocationId: string;
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
  private readonly joinedInvocationIds = new Set<string>();

  constructor(private readonly options: ExpertOrchestratorOptions) {
    this.semaphore = new DelegationSemaphore(options.maxConcurrency);
  }

  get maxDepth(): number {
    return this.options.maxDepth;
  }

  async registerExperts(experts: readonly Expert[]): Promise<void> {
    for (const expert of experts) {
      const current = this.experts.get(expert.id);
      if (current !== undefined && current.version !== expert.version) {
        throw new Error(`Expert recovery version mismatch: ${expert.id}.`);
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
    readonly runtimeId?: string | undefined;
    readonly owner: RuntimeContextOwner;
    readonly resolver: ContextIdResolver;
    readonly source: ContextIdResolutionSource;
  }): Promise<{
    readonly agentId: string;
    readonly invocationId: string;
    readonly expertId: string;
    readonly contextId: string;
    readonly disposition: "created" | "reused";
    readonly status: "queued";
  }> {
    if (request.depth >= this.options.maxDepth) {
      throw new Error(`Expert delegation depth exceeded: ${this.options.maxDepth}`);
    }
    const invocationId = randomUUID();
    const definition = {
      id: request.expert.id,
      version: request.expert.version,
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
        expert: { id: request.expert.id, version: request.expert.version },
        requestedRuntimeId: request.runtimeId,
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
      if (
        reusable !== undefined &&
        (reusable.definition.id !== definition.id ||
          reusable.definition.version !== definition.version)
      ) {
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
        input: request.prompt,
        createdAt: now,
        updatedAt: now,
      };
      try {
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
          status: "queued",
        };
      } catch (error) {
        if (error instanceof ExecutionVersionConflictError) continue;
        throw error;
      }
    }
  }

  async followup(
    ownerContextId: string,
    createdByInvocationId: string,
    request: { readonly agentId: string; readonly prompt: string },
  ): Promise<{
    readonly agentId: string;
    readonly invocationId: string;
    readonly status: "queued";
  }> {
    while (true) {
      const execution = await this.requireExecution();
      const ownerInvocation = await this.requireActiveOwner(createdByInvocationId);
      const agent = await this.requireOwnedAgent(ownerContextId, request.agentId);
      if (agent.lifecycle !== "open") throw new Error(`Agent is closed: ${request.agentId}`);
      const context = await this.options.store.getContext(
        this.options.executionId,
        agent.contextId,
      );
      if (context === undefined) throw new Error(`Runtime Context not found: ${agent.contextId}.`);
      const invocationId = randomUUID();
      const resolution = await new ContextResolutionService(
        this.options.store,
        this.options.readContextScope,
      ).resolve({
        executionId: this.options.executionId,
        invocationId,
        parentInvocationId: createdByInvocationId,
        input: request.prompt,
        state: execution.state,
        source: {
          kind: "expert-delegation",
          callerExpertId: ownerInvocation.executorId ?? ownerInvocation.definition.id,
          ...(ownerInvocation.agentId === undefined
            ? {}
            : { callerAgentId: ownerInvocation.agentId }),
        },
        owner: context.owner,
        ownerContextId,
        expert: context.expert,
        requestedRuntimeId: context.runtimeId,
        resolver: followupContextIdResolver,
        freshContextId: context.contextId,
      });
      if (resolution.context.contextId !== agent.contextId) {
        throw new Error(`Follow-up resolved a different Runtime Context: ${agent.agentId}.`);
      }
      const now = new Date().toISOString();
      const invocation: Invocation = {
        invocationId,
        rootInvocationId: this.options.rootInvocationId,
        parentInvocationId: createdByInvocationId,
        definition: agent.definition,
        executorId: agent.definition.id,
        agentId: agent.agentId,
        agentTaskSequence: agent.nextTaskSequence,
        contextId: agent.contextId,
        contextResolution: {
          resolver: resolution.resolver,
          disposition: resolution.disposition,
        },
        status: "queued",
        input: request.prompt,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await new InvocationService(this.options.executionId, this.options.store).ensureQueued({
          commitId: `agent-followup:${invocationId}`,
          expectedVersion: execution.version,
          invocation,
          agentPatches: [
            { agentId: agent.agentId, patch: { nextTaskSequence: agent.nextTaskSequence + 1 } },
          ],
          queuedData: { agentId: agent.agentId, parentInvocationId: createdByInvocationId },
          events: [
            ...resolution.events,
            {
              invocationId,
              type: "agent.followup.queued",
              data: { agentId: agent.agentId, taskSequence: agent.nextTaskSequence },
            },
          ],
        });
        this.schedule(agent.agentId);
        return { agentId: agent.agentId, invocationId, status: "queued" };
      } catch (error) {
        if (error instanceof ExecutionVersionConflictError) continue;
        throw error;
      }
    }
  }

  async list(ownerContextId: string): Promise<{ readonly experts: readonly unknown[] }> {
    const agents = (await this.options.store.listAgents(this.options.executionId))
      .filter((agent) => agent.ownerContextId === ownerContextId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const invocations = await this.options.store.listInvocations(this.options.executionId);
    return {
      experts: agents.map((agent) => {
        const tasks = invocations
          .filter((invocation) => invocation.agentId === agent.agentId)
          .sort((left, right) => (left.agentTaskSequence ?? 0) - (right.agentTaskSequence ?? 0));
        const active = tasks.find(
          (invocation) => invocation.invocationId === agent.activeInvocationId,
        );
        const queued = tasks.filter((invocation) => invocation.status === "queued");
        const latest = tasks.at(-1);
        const status =
          active?.status === "waiting"
            ? "waiting"
            : active
              ? "running"
              : queued.length
                ? "queued"
                : "idle";
        return {
          agentId: agent.agentId,
          expertId: agent.definition.id,
          status,
          ...(active === undefined ? {} : { activeInvocationId: active.invocationId }),
          queuedInvocationIds: queued.map((invocation) => invocation.invocationId),
          ...(latest === undefined ? {} : { latest: summarizeInvocation(latest) }),
        };
      }),
    };
  }

  async wait(
    ownerContextId: string,
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
    readonly pendingInvocationIds: readonly string[];
  }> {
    await this.assertOwnedInvocations(ownerContextId, request.invocationIds);
    const resume = permit?.suspend();
    try {
      const result = await this.waitForInvocations(request);
      for (const completed of result.completed) {
        this.joinedInvocationIds.add((completed as { invocationId: string }).invocationId);
      }
      return result;
    } finally {
      await resume?.();
    }
  }

  async waitForOwnedUnjoined(
    ownerInvocationId: string,
    ownerContextId: string,
    signal: AbortSignal,
    permit?: DelegationPermit,
  ): Promise<readonly unknown[]> {
    const agents = (await this.options.store.listAgents(this.options.executionId)).filter(
      (agent) => agent.ownerContextId === ownerContextId,
    );
    const allInvocations = await this.options.store.listInvocations(this.options.executionId);
    const descendants = collectDescendantInvocationIds(allInvocations, ownerInvocationId);
    const ids = allInvocations
      .filter(
        (invocation) =>
          descendants.has(invocation.invocationId) &&
          agents.some((agent) => agent.agentId === invocation.agentId),
      )
      .filter((invocation) => !this.joinedInvocationIds.has(invocation.invocationId))
      .map((invocation) => invocation.invocationId);
    if (ids.length === 0) return [];
    const result = await this.wait(
      ownerContextId,
      { invocationIds: ids, returnWhen: "all", signal },
      permit,
    );
    return result.completed;
  }

  async hasOwnedUnjoined(ownerInvocationId: string, ownerContextId: string): Promise<boolean> {
    const agents = (await this.options.store.listAgents(this.options.executionId)).filter(
      (agent) => agent.ownerContextId === ownerContextId,
    );
    if (agents.length === 0) return false;
    const ids = new Set(agents.map((agent) => agent.agentId));
    const invocations = await this.options.store.listInvocations(this.options.executionId);
    const descendants = collectDescendantInvocationIds(invocations, ownerInvocationId);
    return invocations.some(
      (invocation) =>
        descendants.has(invocation.invocationId) &&
        invocation.agentId !== undefined &&
        ids.has(invocation.agentId) &&
        !this.joinedInvocationIds.has(invocation.invocationId),
    );
  }

  async interrupt(
    ownerContextId: string,
    request: {
      readonly agentId: string;
      readonly invocationId?: string | undefined;
      readonly reason?: string | undefined;
    },
  ): Promise<{
    readonly agentId: string;
    readonly invocationId?: string | undefined;
    readonly outcome: "interrupted" | "already_idle";
  }> {
    const agent = await this.requireOwnedAgent(ownerContextId, request.agentId);
    const invocations = (await this.options.store.listInvocations(this.options.executionId))
      .filter((invocation) => invocation.agentId === agent.agentId)
      .sort((left, right) => (left.agentTaskSequence ?? 0) - (right.agentTaskSequence ?? 0));
    const current =
      invocations.find((invocation) => invocation.invocationId === agent.activeInvocationId) ??
      invocations.find((invocation) => invocation.status === "queued");
    if (current === undefined) return { agentId: agent.agentId, outcome: "already_idle" };
    if (request.invocationId !== undefined && request.invocationId !== current.invocationId) {
      throw new Error(
        `Stale interrupt target: expected ${request.invocationId}, current is ${current.invocationId}.`,
      );
    }
    if (current.status === "queued") {
      await this.options.store.commit({
        commitId: `agent-interrupted:${current.invocationId}`,
        executionId: this.options.executionId,
        invocationPatches: [
          {
            invocationId: current.invocationId,
            patch: { status: "interrupted", error: request.reason },
          },
        ],
        events: [
          {
            invocationId: current.invocationId,
            type: "invocation.interrupted",
            data: { agentId: agent.agentId, reason: request.reason },
          },
        ],
      });
      this.schedule(agent.agentId);
    } else {
      await this.options.interruptController.interruptInvocation(
        current.invocationId,
        request.reason,
      );
    }
    return { agentId: agent.agentId, invocationId: current.invocationId, outcome: "interrupted" };
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
      if (active.length === 0) return;
      for (const invocation of active) {
        await this.options.interruptController.interruptInvocation(invocation.invocationId, reason);
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
      if (expert === undefined || expert.version !== agent.definition.version) {
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
      await this.options.store.commit({
        commitId: `agent-activated:${next.invocationId}`,
        executionId: this.options.executionId,
        agentPatches: [{ agentId, patch: { activeInvocationId: next.invocationId } }],
        events: [
          { invocationId: next.invocationId, type: "agent.task.activated", data: { agentId } },
        ],
      });
      try {
        const activeAgent = (await this.options.store.getAgent(this.options.executionId, agentId))!;
        await this.options.execute({
          agent: activeAgent,
          invocation: latest,
          expert,
          prompt: String(latest.input),
          runtimeId: context.runtimeId,
          permit,
        });
      } catch {
        const current = await this.options.store.getInvocation(
          this.options.executionId,
          next.invocationId,
        );
        if (current !== undefined && !isTerminalExecutionStatus(current.status)) {
          await this.failUnrecoverableJob(
            current,
            "Expert task failed before reaching a terminal state.",
          );
        }
      } finally {
        const currentAgent = await this.options.store.getAgent(this.options.executionId, agentId);
        if (currentAgent?.activeInvocationId === next.invocationId) {
          await this.options.store.commit({
            commitId: `agent-idle:${next.invocationId}`,
            executionId: this.options.executionId,
            agentPatches: [{ agentId, patch: { activeInvocationId: undefined } }],
            events: [
              { invocationId: next.invocationId, type: "agent.task.released", data: { agentId } },
            ],
          });
        }
        permit.release();
      }
    }
  }

  private async waitForInvocations(request: {
    readonly invocationIds: readonly string[];
    readonly returnWhen?: "all" | "any" | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{
    readonly returnWhen: "all" | "any";
    readonly timedOut: boolean;
    readonly completed: readonly unknown[];
    readonly pendingInvocationIds: readonly string[];
  }> {
    const returnWhen = request.returnWhen ?? "all";
    const subscription = getExecutionLiveBus(this.options.store).subscribeEvents(
      this.options.executionId,
    );
    const iterator = subscription[Symbol.asyncIterator]();
    const deadline = request.timeoutMs === undefined ? undefined : Date.now() + request.timeoutMs;
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
        if (conditionMet || timedOut) {
          return {
            returnWhen,
            timedOut: !conditionMet && timedOut,
            completed: completed.map(summarizeInvocation),
            pendingInvocationIds: invocations
              .filter((invocation) => !isTerminalExecutionStatus(invocation.status))
              .map((invocation) => invocation.invocationId),
          };
        }
        await waitForEvent(iterator, deadline, request.signal);
      }
    } finally {
      await subscription.close();
    }
  }

  private async assertOwnedInvocations(
    ownerContextId: string,
    invocationIds: readonly string[],
  ): Promise<void> {
    const invocations = await this.loadInvocations(invocationIds);
    const agents = new Map(
      (await this.options.store.listAgents(this.options.executionId)).map((agent) => [
        agent.agentId,
        agent,
      ]),
    );
    for (const invocation of invocations) {
      const agent = invocation.agentId === undefined ? undefined : agents.get(invocation.agentId);
      if (agent?.ownerContextId !== ownerContextId) {
        throw new Error(
          `Invocation is not owned by the current Expert: ${invocation.invocationId}`,
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

  private async requireOwnedAgent(ownerContextId: string, agentId: string): Promise<AgentInstance> {
    const agent = await this.options.store.getAgent(this.options.executionId, agentId);
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
    await this.options.store.commit({
      commitId: `agent-failed:${invocation.invocationId}`,
      executionId: this.options.executionId,
      invocationPatches: [
        { invocationId: invocation.invocationId, patch: { status: "failed", error: { message } } },
      ],
      events: [
        { invocationId: invocation.invocationId, type: "invocation.failed", data: { message } },
      ],
    });
  }

  private async scheduleRecoverableAgents(): Promise<void> {
    for (const agent of await this.options.store.listAgents(this.options.executionId)) {
      if (
        agent.lifecycle === "open" &&
        this.experts.get(agent.definition.id)?.version === agent.definition.version
      ) {
        this.schedule(agent.agentId);
      }
    }
  }
}

class DelegationSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<DelegationPermit> {
    await this.acquireSlot();
    let held = true;
    return {
      suspend: () => {
        if (!held) return undefined;
        held = false;
        this.releaseSlot();
        return async () => {
          if (held) return;
          await this.acquireSlot();
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

  private async acquireSlot(): Promise<void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      return;
    }
    this.active += 1;
  }

  private releaseSlot(): void {
    if (this.active < 1) throw new Error("Delegation concurrency slot underflow.");
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.active -= 1;
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

function summarizeInvocation(invocation: Invocation): unknown {
  return {
    agentId: invocation.agentId,
    invocationId: invocation.invocationId,
    status: invocation.status,
    ...(invocation.output === undefined ? {} : { output: invocation.output }),
    ...(invocation.error === undefined ? {} : { error: invocation.error }),
    ...(invocation.usage === undefined ? {} : { usage: invocation.usage }),
  };
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
