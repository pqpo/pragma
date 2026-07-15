import { randomUUID } from "node:crypto";

import {
  isTerminalExecutionStatus,
  type AgentInstance,
  type AgentMessage,
  type AgentMessageUsage,
  type ExpertAgentStreamEvent,
  type Invocation,
  type RuntimeContextRecord,
  type RuntimeContextSnapshot as SharedRuntimeContextSnapshot,
} from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import {
  createTeamDelegationTools,
  isAgentDelegationTool,
  readAgentDelegationDefinition,
  type AgentDelegationDefinition,
  type RuntimeByExpert,
} from "../agent/agent-launcher.ts";
import { isExpertTeam, type ExpertDefinition, type ExpertTeam } from "../agent/expert-team.ts";
import type { RuntimeAgentSession, RuntimeSubmitHandle } from "../runtime/runtime-adapter.ts";
import { mergeUsage } from "../runtime/usage.ts";
import { openRuntimeSession } from "../runtime/session-factory.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";
import type { ExpertAgentHumanRequest, ExpertAgentHumanResponse } from "../tools/managed-tool.ts";
import {
  ExecutionFinalStatusConflictError,
  ExecutionVersionConflictError,
  type ExecutionStore,
} from "./execution-store.ts";
import {
  ExpertOrchestrator,
  type DelegationPermit,
  type ExpertInvocationJob,
} from "./expert-orchestrator.ts";
import {
  prepareExecutionContextClosure,
  type ContextResolutionScopeReader,
} from "./context-resolution-service.ts";
import { getExecutionLiveBus } from "./execution-live-bus.ts";
import { projectRuntimeOutput } from "./execution-output.ts";
import { RuntimeMessageAccumulator } from "./runtime-message-accumulator.ts";
import { requireInvocationContextOrigin } from "./runtime-context-record.ts";
import { RuntimeSessionPool, type RuntimeSessionIdentity } from "./runtime-session-pool.ts";

export type RuntimeContextSnapshot = SharedRuntimeContextSnapshot;

interface ActiveSubmission {
  readonly invocationId: string;
  readonly contextId: string;
  readonly session: RuntimeAgentSession;
  readonly handle: RuntimeSubmitHandle;
}

export class ExecutionController {
  private readonly activeRuntimeSessions = new Map<string, RuntimeAgentSession>();
  private readonly activeRuntimeSubmissions = new Map<string, ActiveSubmission>();
  private readonly runtimeSubmissionWaiters = new Map<
    string,
    Set<{
      readonly resolve: (submission: ActiveSubmission) => void;
      readonly reject: (reason: unknown) => void;
    }>
  >();
  private readonly invocationSignals = new Map<string, AbortController>();
  private readonly pendingInteractions = new Map<
    string,
    {
      resolve(value: ExpertAgentHumanResponse): void;
      reject(reason: unknown): void;
      requestId?: string;
    }
  >();
  private cancelled = false;
  private cancellationReason: Error | undefined;
  private usage: AgentMessageUsage | undefined;

  constructor(
    readonly executionId: string,
    readonly store: ExecutionStore,
    private readonly runtimeSessions: RuntimeSessionPool = new RuntimeSessionPool(),
    private readonly options: { readonly closeContextsOnCancel?: boolean } = {},
  ) {}

  isCancelled(): boolean {
    return this.cancelled;
  }

  getCancellationReason(): Error | undefined {
    return this.cancellationReason;
  }

  addUsage(usage: AgentMessageUsage | undefined): void {
    this.usage = mergeUsage(this.usage, usage);
  }

  getUsage(): AgentMessageUsage | undefined {
    return this.usage;
  }

  signalForInvocation(invocationId: string): AbortSignal {
    const existing = this.invocationSignals.get(invocationId);
    if (existing !== undefined) return existing.signal;
    const created = new AbortController();
    if (this.cancelled) created.abort(new Error(`Execution cancelled: ${this.executionId}`));
    this.invocationSignals.set(invocationId, created);
    return created.signal;
  }

  async acquireRuntime(
    identity: RuntimeSessionIdentity,
    create: () => Promise<RuntimeAgentSession>,
  ): Promise<RuntimeAgentSession> {
    const session = await this.runtimeSessions.acquire(identity, create);
    this.activeRuntimeSessions.set(identity.contextId, session);
    if (this.cancelled) {
      await session.close();
      throw new Error(`Execution cancelled: ${this.executionId}`);
    }
    return session;
  }

  async releaseRuntime(identity: RuntimeSessionIdentity): Promise<void> {
    this.activeRuntimeSessions.delete(identity.contextId);
    await this.runtimeSessions.release(identity);
  }

  registerRuntimeSubmission(
    invocationId: string,
    contextId: string,
    session: RuntimeAgentSession,
    handle: RuntimeSubmitHandle,
  ): void {
    const submission = { invocationId, contextId, session, handle };
    this.activeRuntimeSubmissions.set(invocationId, submission);
    const waiters = this.runtimeSubmissionWaiters.get(contextId);
    if (waiters === undefined) return;
    this.runtimeSubmissionWaiters.delete(contextId);
    for (const waiter of waiters) waiter.resolve(submission);
  }

  unregisterRuntimeSubmission(invocationId: string, runId: string): void {
    if (this.activeRuntimeSubmissions.get(invocationId)?.handle.runId === runId) {
      this.activeRuntimeSubmissions.delete(invocationId);
    }
  }

  async interruptInvocation(invocationId: string, reason?: string): Promise<boolean> {
    const invocation = await this.store.getInvocation(this.executionId, invocationId);
    if (invocation === undefined) throw new Error(`Invocation not found: ${invocationId}`);
    if (isTerminalExecutionStatus(invocation.status)) return false;
    try {
      await this.store.commit({
        commitId: `invocation-interrupted:${invocationId}`,
        executionId: this.executionId,
        invocationPatches: [{ invocationId, patch: { status: "interrupted", error: reason } }],
        events: [{ invocationId, type: "invocation.interrupted", data: { reason } }],
      });
    } catch (error) {
      if (!(error instanceof ExecutionFinalStatusConflictError)) throw error;
      return false;
    }
    const controller = this.invocationSignals.get(invocationId) ?? new AbortController();
    this.invocationSignals.set(invocationId, controller);
    controller.abort(new Error(reason ?? `Invocation interrupted: ${invocationId}`));
    await this.activeRuntimeSubmissions.get(invocationId)?.handle.cancel();
    return true;
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
      { interactionId, request },
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
    this.cancellationReason = cancellation;
    this.rejectRuntimeSubmissionWaiters(cancellation);
    for (const controller of this.invocationSignals.values()) controller.abort(cancellation);
    for (const pending of this.pendingInteractions.values()) pending.reject(cancellation);
    this.pendingInteractions.clear();
    await Promise.allSettled(
      [...this.activeRuntimeSubmissions.values()].map((submission) => submission.handle.cancel()),
    );
    while (true) {
      const record = await this.store.get(this.executionId);
      if (record === undefined || isTerminalExecutionStatus(record.status)) return;
      const invocationPatches = (await this.store.listInvocations(this.executionId))
        .filter((invocation) => !isTerminalExecutionStatus(invocation.status))
        .map((invocation) => ({
          invocationId: invocation.invocationId,
          patch: { status: "cancelled" as const, error: reason },
        }));
      const closure =
        this.options.closeContextsOnCancel === true
          ? await prepareExecutionContextClosure(this.store, this.executionId)
          : { contextPatches: [], agentPatches: [], events: [] };
      try {
        await this.store.commit({
          commitId: randomUUID(),
          executionId: this.executionId,
          expectedVersion: record.version,
          executionPatch: { status: "cancelled", error: reason },
          invocationPatches,
          contextPatches: closure.contextPatches,
          agentPatches: closure.agentPatches,
          events: [
            ...closure.events,
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
    const submission = await this.waitForRuntimeSubmission(contextId);
    await submission.session.steer(request);
  }

  finish(): void {
    this.rejectRuntimeSubmissionWaiters(
      new Error("ExpertTurn completed before its Runtime submission became active."),
    );
    this.activeRuntimeSubmissions.clear();
    this.invocationSignals.clear();
    getExecutionLiveBus(this.store).complete(this.executionId);
  }

  async closeRuntimes(): Promise<void> {
    await this.runtimeSessions.close();
    this.activeRuntimeSessions.clear();
  }

  private async waitForRuntimeSubmission(contextId: string): Promise<ActiveSubmission> {
    const active = [...this.activeRuntimeSubmissions.values()].find(
      (submission) => submission.contextId === contextId,
    );
    if (active !== undefined) return active;
    if (this.cancelled) throw new Error(`Execution cancelled: ${this.executionId}`);
    return await new Promise((resolve, reject) => {
      const waiters = this.runtimeSubmissionWaiters.get(contextId) ?? new Set();
      waiters.add({ resolve, reject });
      this.runtimeSubmissionWaiters.set(contextId, waiters);
    });
  }

  private rejectRuntimeSubmissionWaiters(reason: unknown): void {
    for (const waiters of this.runtimeSubmissionWaiters.values()) {
      for (const waiter of waiters) waiter.reject(reason);
    }
    this.runtimeSubmissionWaiters.clear();
  }
}

export interface RunExpertInvocationOptions {
  readonly executionId: string;
  readonly invocationId: string;
  readonly parentInvocationId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly expert: ExpertDefinition;
  readonly prompt: string;
  readonly owner:
    | { readonly type: "expert-session"; readonly ownerId: string }
    | { readonly type: "flow-execution"; readonly ownerId: string };
  readonly runtimeByExpert?: RuntimeByExpert | undefined;
  readonly context: RuntimeContextRecord;
  readonly controller: ExecutionController;
  readonly store: ExecutionStore;
  readonly runtimes: RuntimeRegistry;
  readonly team?: ExpertTeam | undefined;
  readonly depth?: number | undefined;
  readonly persistContext?: ((context: RuntimeContextRecord) => Promise<void>) | undefined;
  readonly readContextScope?: ContextResolutionScopeReader | undefined;
  readonly orchestrator?: ExpertOrchestrator | undefined;
  readonly delegationPermit?: DelegationPermit | undefined;
}

export async function runExpertInvocation(options: RunExpertInvocationOptions): Promise<unknown> {
  const team = isExpertTeam(options.expert) ? options.expert : options.team;
  const nativeExpert = isExpertTeam(options.expert) ? options.expert.coordinator : options.expert;
  const depth = options.depth ?? 0;
  const teamTools = team === undefined ? [] : createTeamDelegationTools(team, nativeExpert.id);
  const executableExpert =
    team === undefined ? nativeExpert : withTeamDelegationTools(nativeExpert, teamTools);
  const delegation =
    teamTools.length === 0
      ? team === undefined
        ? readExpertDelegationDefinition(nativeExpert)
        : undefined
      : readAgentDelegationDefinition(teamTools[0]!);

  let orchestrator = options.orchestrator;
  if (orchestrator === undefined && delegation !== undefined) {
    const created: ExpertOrchestrator = new ExpertOrchestrator({
      executionId: options.executionId,
      rootInvocationId: (await requireExecution(options.store, options.executionId))
        .rootInvocationId,
      store: options.store,
      maxConcurrency: delegation.maxConcurrency,
      maxDepth: delegation.maxDepth,
      interruptController: options.controller,
      execute: async (job): Promise<void> => await executeAgentJob(options, team, created, job),
      ...(options.readContextScope === undefined
        ? {}
        : { readContextScope: options.readContextScope }),
      ...(options.persistContext === undefined ? {} : { persistContext: options.persistContext }),
    });
    orchestrator = created;
  }
  if (orchestrator !== undefined && delegation !== undefined) {
    await orchestrator.registerExperts(delegation.experts);
  }

  const invocation = await requireInvocation(
    options.store,
    options.executionId,
    options.invocationId,
  );
  if (invocation.status === "succeeded") {
    options.controller.addUsage(invocation.usage);
    return invocation.output;
  }
  options.controller.addUsage(invocation.usage);
  await options.store.commit({
    commitId: `invocation-started:${options.invocationId}`,
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
  await appendUserMessage(
    options,
    options.prompt,
    `invocation-user-message:${options.invocationId}`,
  );
  const invocationSignal = options.controller.signalForInvocation(options.invocationId);
  throwIfAborted(invocationSignal, options.invocationId);

  const runtime = options.runtimes.resolve(options.context.runtimeId);
  validateDelegatedRuntimeRouting(options, delegation, runtime.descriptor.id);
  const runtimeIdentity = {
    contextId: options.context.contextId,
    expertId: nativeExpert.id,
    runtimeId: runtime.descriptor.id,
  } satisfies RuntimeSessionIdentity;
  assertRuntimeIdentity(options, runtimeIdentity);

  const persistRuntimeSnapshot = async (snapshot: RuntimeContextSnapshot): Promise<void> => {
    const next: RuntimeContextRecord = {
      ...options.context,
      snapshot,
      updatedAt: new Date().toISOString(),
    };
    const localContext = await options.store.getContext(
      options.executionId,
      options.context.contextId,
    );
    await Promise.all([
      ...(options.persistContext === undefined ? [] : [options.persistContext(next)]),
      ...(localContext === undefined
        ? []
        : [
            options.store.commit({
              commitId: randomUUID(),
              executionId: options.executionId,
              contextPatches: [
                {
                  contextId: options.context.contextId,
                  patch: { snapshot },
                },
              ],
            }),
          ]),
    ]);
  };

  const executionContext = createExecutionContext(
    options,
    nativeExpert,
    team,
    delegation,
    orchestrator,
    depth,
    runtime.descriptor.id,
  );
  const humanInteractionHandler = async (request: ExpertAgentHumanRequest) =>
    await options.controller.requestHumanInteraction(options.invocationId, request);
  const session = await options.controller.acquireRuntime(runtimeIdentity, async () => {
    const opened = await openRuntimeSession(runtime, {
      agent: executableExpert,
      owner:
        options.owner.type === "expert-session"
          ? { ...options.owner, contextId: options.context.contextId }
          : {
              ...options.owner,
              invocationId: requireInvocationContextOrigin(options.context),
            },
      systemSessionId: options.context.snapshot?.systemSessionId,
      runtimeSession: options.context.snapshot?.runtimeSession,
      executionContext,
      humanInteractionHandler,
      onSessionInfo: async (info) => {
        if (info.runtimeSession.id === "") return;
        await persistRuntimeSnapshot({
          systemSessionId: info.systemSessionId,
          runtimeSession: info.runtimeSession,
        });
      },
    });
    const info = opened.info();
    if (info.runtimeSession.id !== "") {
      await persistRuntimeSnapshot({
        systemSessionId: info.systemSessionId,
        runtimeSession: info.runtimeSession,
      });
    }
    return opened;
  });
  throwIfAborted(invocationSignal, options.invocationId);

  let query = options.prompt;
  let continuation = 0;
  let invocationUsage = invocation.usage;
  try {
    while (true) {
      const turn = await submitRuntimeTurn({
        options,
        invocation,
        session,
        query,
        runId:
          continuation === 0
            ? options.invocationId
            : `${options.invocationId}:continuation:${continuation}`,
        executionContext,
        humanInteractionHandler,
        runtimeSource: runtime.descriptor,
      });
      options.controller.addUsage(turn.usage);
      invocationUsage = mergeUsage(invocationUsage, turn.usage);
      await persistSessionInfo(session, persistRuntimeSnapshot);

      if (
        orchestrator !== undefined &&
        (await orchestrator.hasOwnedUnjoined(options.invocationId, options.context.contextId))
      ) {
        await options.store.commit({
          commitId: randomUUID(),
          executionId: options.executionId,
          invocationPatches: [
            {
              invocationId: options.invocationId,
              patch: {
                status: "waiting",
                ...(invocationUsage === undefined ? {} : { usage: invocationUsage }),
              },
            },
          ],
          events: [
            { invocationId: options.invocationId, type: "expert.children.waiting", data: {} },
          ],
        });
        await orchestrator.waitForOwnedUnjoined(
          options.invocationId,
          options.context.contextId,
          options.controller.signalForInvocation(options.invocationId),
          options.delegationPermit,
        );
        const result = await orchestrator.list(options.context.contextId);
        query = [
          "[Pragma orchestration continuation]",
          "All attached Expert tasks are terminal. Synthesize their results into the final answer.",
          "Do not spawn replacement tasks for work that is already complete.",
          JSON.stringify(result, null, 2),
        ].join("\n");
        continuation += 1;
        await options.store.commit({
          commitId: randomUUID(),
          executionId: options.executionId,
          invocationPatches: [{ invocationId: options.invocationId, patch: { status: "running" } }],
          events: [
            {
              invocationId: options.invocationId,
              type: "expert.children.completed",
              data: result,
            },
          ],
        });
        await appendUserMessage(
          options,
          query,
          `invocation-continuation-message:${options.invocationId}:${continuation}`,
        );
        continue;
      }

      await options.store.commit({
        commitId: `invocation-succeeded:${options.invocationId}`,
        executionId: options.executionId,
        invocationPatches: [
          {
            invocationId: options.invocationId,
            patch: {
              status: "succeeded",
              output: turn.output,
              ...(invocationUsage === undefined ? {} : { usage: invocationUsage }),
            },
          },
        ],
        events: [
          {
            invocationId: options.invocationId,
            type: "invocation.succeeded",
            data: {
              output: turn.output,
              ...(invocationUsage === undefined ? {} : { usage: invocationUsage }),
            },
          },
        ],
      });
      return turn.output;
    }
  } catch (error) {
    let failure = error;
    try {
      await orchestrator?.interruptOwned(
        options.invocationId,
        `Owner Invocation failed: ${options.invocationId}`,
      );
    } catch (cleanupError) {
      failure = new AggregateError(
        [error, cleanupError],
        `Invocation ${options.invocationId} failed and its descendants could not be interrupted.`,
      );
    }
    const latest = await options.store.getInvocation(options.executionId, options.invocationId);
    const status = options.controller.isCancelled()
      ? "cancelled"
      : latest?.status === "interrupted"
        ? "interrupted"
        : "failed";
    if (latest !== undefined && !isTerminalExecutionStatus(latest.status)) {
      await options.store.commit({
        commitId: `invocation-${status}:${options.invocationId}`,
        executionId: options.executionId,
        invocationPatches: [
          { invocationId: options.invocationId, patch: { status, error: serializeError(failure) } },
        ],
        events: [
          {
            invocationId: options.invocationId,
            type: `invocation.${status}`,
            data: { message: failure instanceof Error ? failure.message : String(failure) },
          },
        ],
      });
    }
    throw failure;
  } finally {
    // Context lifetime is controlled by its owner, not by one Invocation.
  }
}

async function executeAgentJob(
  parent: RunExpertInvocationOptions,
  team: ExpertTeam | undefined,
  orchestrator: ExpertOrchestrator,
  job: ExpertInvocationJob,
): Promise<void> {
  const context = await parent.store.getContext(parent.executionId, job.agent.contextId);
  if (context === undefined) throw new Error(`Runtime Context not found: ${job.agent.contextId}.`);
  await runExpertInvocation({
    executionId: parent.executionId,
    invocationId: job.invocation.invocationId,
    parentInvocationId: job.invocation.parentInvocationId,
    agentId: job.agent.agentId,
    expert: job.expert,
    prompt: job.prompt,
    owner: parent.owner,
    context,
    controller: parent.controller,
    store: parent.store,
    runtimes: parent.runtimes,
    team,
    depth: await readAgentDepth(parent.store, parent.executionId, job.agent),
    orchestrator,
    delegationPermit: job.permit,
    ...(parent.runtimeByExpert === undefined ? {} : { runtimeByExpert: parent.runtimeByExpert }),
    ...(parent.readContextScope === undefined ? {} : { readContextScope: parent.readContextScope }),
    ...(parent.persistContext === undefined ? {} : { persistContext: parent.persistContext }),
  });
}

function createExecutionContext(
  options: RunExpertInvocationOptions,
  nativeExpert: Expert,
  team: ExpertTeam | undefined,
  delegation: AgentDelegationDefinition | undefined,
  orchestrator: ExpertOrchestrator | undefined,
  depth: number,
  parentRuntimeId: string,
) {
  const base = { executionId: options.executionId, invocationId: options.invocationId, depth };
  if (delegation === undefined || orchestrator === undefined) return base;
  return {
    ...base,
    spawnExpert: async (request: { readonly expertId: string; readonly prompt: string }) => {
      const expert = delegation.experts.find((candidate) => candidate.id === request.expertId);
      if (expert === undefined) {
        throw new Error(`Expert ${nativeExpert.id} may not spawn ${request.expertId}.`);
      }
      const childRuntimeId = resolveDelegatedRuntimeId(
        options,
        delegation,
        expert.id,
        parentRuntimeId,
      );
      return await orchestrator.spawn({
        ownerContextId: options.context.contextId,
        createdByInvocationId: options.invocationId,
        parentAgentId: options.agentId,
        depth,
        expert,
        prompt: request.prompt,
        runtimeId: childRuntimeId,
        owner: options.owner,
        resolver: delegation.contextId,
        source:
          team === undefined
            ? {
                kind: "expert-delegation",
                callerExpertId: nativeExpert.id,
                ...(options.agentId === undefined ? {} : { callerAgentId: options.agentId }),
              }
            : {
                kind: "expert-team",
                teamId: team.id,
                callerExpertId: nativeExpert.id,
                ...(options.agentId === undefined ? {} : { callerAgentId: options.agentId }),
              },
      });
    },
    waitExperts: async (request: {
      readonly invocationIds: readonly string[];
      readonly returnWhen?: "all" | "any" | undefined;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    }) => await orchestrator.wait(options.context.contextId, request, options.delegationPermit),
    listExperts: async () => await orchestrator.list(options.context.contextId),
    followupExpert: async (request: { readonly agentId: string; readonly prompt: string }) =>
      await orchestrator.followup(options.context.contextId, options.invocationId, request),
    interruptExpert: async (request: {
      readonly agentId: string;
      readonly invocationId?: string | undefined;
      readonly reason?: string | undefined;
    }) => await orchestrator.interrupt(options.context.contextId, request),
  };
}

async function submitRuntimeTurn(options: {
  readonly options: RunExpertInvocationOptions;
  readonly invocation: Invocation;
  readonly session: RuntimeAgentSession;
  readonly query: string;
  readonly runId: string;
  readonly executionContext: ReturnType<typeof createExecutionContext>;
  readonly humanInteractionHandler: (
    request: ExpertAgentHumanRequest,
  ) => Promise<ExpertAgentHumanResponse>;
  readonly runtimeSource: { readonly id: string; readonly kind: string };
}): Promise<{ readonly output: unknown; readonly usage?: AgentMessageUsage | undefined }> {
  const handle = options.session.submit({
    runId: options.runId,
    query: options.query,
    execution: {
      context: options.executionContext,
      humanInteractionHandler: options.humanInteractionHandler,
    },
  });
  options.options.controller.registerRuntimeSubmission(
    options.options.invocationId,
    options.options.context.contextId,
    options.session,
    handle,
  );
  const messageAccumulator = new RuntimeMessageAccumulator(options.runtimeSource);
  const liveBus = getExecutionLiveBus(options.options.store);
  const drain = (async () => {
    for await (const event of handle.events) {
      const output = projectRuntimeOutput({
        executionId: options.options.executionId,
        invocation: options.invocation,
        event,
      });
      if (output !== undefined) liveBus.publish(options.options.executionId, output);
      for (const message of messageAccumulator.consume(event)) {
        await options.options.store.appendEvent(
          options.options.executionId,
          options.options.invocationId,
          "invocation.message.appended",
          { message },
          `invocation-message:${event.eventId}:${message.timestamp}`,
        );
      }
      if (isDurableRuntimeEvent(event)) {
        await options.options.store.appendEvent(
          options.options.executionId,
          options.options.invocationId,
          "runtime.event",
          event,
          event.eventId,
        );
      }
    }
  })();
  try {
    const result = await handle.result;
    await drain;
    const output = result.result.output;
    const finalMessage = messageAccumulator.complete(output, result.result.usage);
    if (finalMessage !== undefined) {
      await options.options.store.appendEvent(
        options.options.executionId,
        options.options.invocationId,
        "invocation.message.appended",
        { message: finalMessage },
        `invocation-final-message:${options.runId}`,
      );
    }
    return { output, usage: result.result.usage };
  } finally {
    await drain.catch(() => undefined);
    options.options.controller.unregisterRuntimeSubmission(
      options.options.invocationId,
      handle.runId,
    );
  }
}

function withTeamDelegationTools(
  expert: Expert,
  tools: readonly NonNullable<Expert["tools"]>[number][],
): Expert {
  const clone = Object.create(Object.getPrototypeOf(expert)) as Expert;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(expert));
  Object.defineProperty(clone, "tools", {
    value: [
      ...(expert.tools ?? []).filter((candidate) => !isAgentDelegationTool(candidate)),
      ...tools,
    ],
    enumerable: true,
  });
  return clone;
}

function readExpertDelegationDefinition(expert: Expert): AgentDelegationDefinition | undefined {
  const definitions = new Set(
    (expert.tools ?? []).flatMap((tool) => {
      const definition = readAgentDelegationDefinition(tool);
      return definition === undefined ? [] : [definition];
    }),
  );
  if (definitions.size > 1) throw new Error(`Expert ${expert.id} has multiple agent launchers.`);
  const definition = [...definitions][0];
  if (definition?.experts.some((candidate) => candidate.id === expert.id) === true) {
    throw new Error(`Expert ${expert.id} may not spawn itself.`);
  }
  return definition;
}

async function appendUserMessage(
  options: RunExpertInvocationOptions,
  content: string,
  eventId: string,
): Promise<void> {
  await options.store.appendEvent(
    options.executionId,
    options.invocationId,
    "invocation.message.appended",
    { message: { role: "user", content, timestamp: Date.now() } satisfies AgentMessage },
    eventId,
  );
}

async function persistSessionInfo(
  session: RuntimeAgentSession,
  persist: (snapshot: RuntimeContextSnapshot) => Promise<void>,
): Promise<void> {
  const info = session.info();
  await persist({
    systemSessionId: info.systemSessionId,
    runtimeSession: info.runtimeSession,
  });
}

function assertRuntimeIdentity(
  options: RunExpertInvocationOptions,
  identity: RuntimeSessionIdentity,
): void {
  if (
    options.context.expert.id !== identity.expertId ||
    options.context.runtimeId !== identity.runtimeId
  ) {
    throw new Error(
      `Runtime Context ${options.context.contextId} identity conflicts with ${identity.expertId}/${identity.runtimeId}.`,
    );
  }
}

async function readAgentDepth(
  store: ExecutionStore,
  executionId: string,
  agent: AgentInstance,
): Promise<number> {
  const byId = new Map(
    (await store.listAgents(executionId)).map((candidate) => [candidate.agentId, candidate]),
  );
  let depth = 1;
  let current = agent;
  const visited = new Set([agent.agentId]);
  while (current.parentAgentId !== undefined) {
    const parent = byId.get(current.parentAgentId);
    if (parent === undefined) throw new Error(`Parent Agent not found: ${current.parentAgentId}.`);
    if (visited.has(parent.agentId))
      throw new Error(`Cyclic Agent parent chain: ${parent.agentId}.`);
    visited.add(parent.agentId);
    depth += 1;
    current = parent;
  }
  return depth;
}

async function requireExecution(store: ExecutionStore, executionId: string) {
  const execution = await store.get(executionId);
  if (execution === undefined) throw new Error(`Execution not found: ${executionId}`);
  return execution;
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

function serializeError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}

function throwIfAborted(signal: AbortSignal, invocationId: string): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(`Invocation interrupted: ${invocationId}`);
}

function resolveDelegatedRuntimeId(
  options: RunExpertInvocationOptions,
  delegation: AgentDelegationDefinition,
  expertId: string,
  parentRuntimeId: string,
): string {
  const configuredRuntimeId =
    options.runtimeByExpert?.[expertId] ??
    delegation.runtimeByExpert.get(expertId) ??
    parentRuntimeId;
  return options.runtimes.resolve(configuredRuntimeId).descriptor.id;
}

function validateDelegatedRuntimeRouting(
  options: RunExpertInvocationOptions,
  delegation: AgentDelegationDefinition | undefined,
  parentRuntimeId: string,
): void {
  if (delegation === undefined) return;
  for (const expert of delegation.experts) {
    resolveDelegatedRuntimeId(options, delegation, expert.id, parentRuntimeId);
  }
}

function isDurableRuntimeEvent(event: ExpertAgentStreamEvent): boolean {
  return (
    event.type !== "message.delta" &&
    event.type !== "message.completed" &&
    event.type !== "thought.delta" &&
    event.type !== "tool.delta"
  );
}
