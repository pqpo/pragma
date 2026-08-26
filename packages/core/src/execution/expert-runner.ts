import { createHash, randomUUID } from "node:crypto";

import {
  AgentMessageSchema,
  InvocationOutputSchema,
  isTerminalExecutionStatus,
  type AgentInstance,
  type AgentMessage,
  type AgentMessageUsage,
  type ExpertAgentStreamEvent,
  type ExpertPromptAttachment,
  type Invocation,
  type InvocationOutput,
  type RuntimeContextRecord,
  type RuntimeEnvironmentBinding,
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
import { ContextManager } from "../agent/context-manager.ts";
import { StaticContextStore } from "../context-system/static-context-store.ts";
import {
  hostContextBindingsFingerprint,
  withHostContextBindings,
  type HostContextBindings,
  type HostContextBindingsResolver,
} from "../context-system/host-context-bindings.ts";
import { freshContextIdResolver } from "./context-id-resolver.ts";
import type { Flow } from "../flow/flow.ts";
import { runNestedFlowInvocation } from "../flow/flow-execution.ts";
import type {
  RuntimeAgentSession,
  RuntimeModelSelection,
  RuntimeSubmitHandle,
} from "../runtime/runtime-adapter.ts";
import { mergeUsage, type UsageSink } from "../runtime/usage.ts";
import { isRuntimeFeatureEnabled } from "../runtime/features.ts";
import { openRuntimeSession } from "../runtime/session-factory.ts";
import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CONTEXT_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
} from "../runtime/run-context.ts";
import type { RuntimeResolver } from "../runtime-resolver.ts";
import { createPragmaLogger, type PragmaLoggerProvider } from "../logging/logger.ts";
import type {
  ExpertAgentAutomaticHumanInteractionHandler,
  ExpertAgentHumanRequest,
  ExpertAgentHumanResponse,
} from "../tools/managed-tool.ts";
import {
  ExpertAgentHumanRequestSchema,
  ExpertAgentHumanResponseSchema,
} from "../tools/managed-tool.ts";
import { sameHumanRequest } from "../human-interaction/durable-human-interaction.ts";
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
  ContextResolutionService,
  prepareExecutionContextClosure,
  type ContextResolutionScopeReader,
} from "./context-resolution-service.ts";
import { getExecutionLiveBus } from "./execution-live-bus.ts";
import { projectRuntimeOutput } from "./execution-output.ts";
import { RuntimeMessageAccumulator } from "./runtime-message-accumulator.ts";
import { requireInvocationContextOrigin } from "./runtime-context-record.ts";
import {
  RuntimeSessionPool,
  type RuntimeSessionCreateOptions,
  type RuntimeSessionIdentity,
} from "./runtime-session-pool.ts";
import { ContextOutputService, unwrapInvocationOutput } from "./context-output-service.ts";
import { formatExpertPromptWithAttachments } from "./expert-prompt.ts";

export type RuntimeContextSnapshot = SharedRuntimeContextSnapshot;

const AUTOMATIC_EXPERT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;

interface ActiveSubmission {
  readonly invocationId: string;
  readonly contextId: string;
  readonly session: RuntimeAgentSession;
  readonly handle: RuntimeSubmitHandle;
  readonly supportsSteer: boolean;
}

interface StoredHumanInteraction {
  readonly interactionId: string;
  readonly invocationId: string;
  readonly request: ExpertAgentHumanRequest;
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
  private readonly linkedInvocationSignals = new Map<string, AbortSignal>();
  private readonly orchestrators = new Map<string, ExpertOrchestrator>();
  private readonly pendingInteractions = new Map<
    string,
    {
      invocationId: string;
      resolve(value: ExpertAgentHumanResponse): void;
      reject(reason: unknown): void;
    }
  >();
  private readonly humanResponseOperations = new Map<
    string,
    { readonly requestId: string; readonly promise: Promise<void> }
  >();
  private cancelled = false;
  private cancellationReason: Error | undefined;
  private usage: AgentMessageUsage | undefined;
  private readonly recoverableInteractions: Promise<StoredHumanInteraction[]>;

  constructor(
    readonly executionId: string,
    readonly store: ExecutionStore,
    private readonly runtimeSessions: RuntimeSessionPool = new RuntimeSessionPool(),
    private readonly options: {
      readonly closeContextsOnCancel?: boolean;
      readonly recoverHumanInteractionIds?: readonly string[];
      readonly automaticHumanInteractionHandler?:
        ExpertAgentAutomaticHumanInteractionHandler | undefined;
    } = {},
  ) {
    this.recoverableInteractions =
      options.recoverHumanInteractionIds === undefined
        ? Promise.resolve([])
        : readHumanInteractionsById(store, executionId, options.recoverHumanInteractionIds);
  }

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

  signalForInvocation(invocationId: string, parentInvocationId?: string): AbortSignal {
    const linked = this.linkedInvocationSignals.get(invocationId);
    if (linked !== undefined) return linked;
    const existing = this.invocationSignals.get(invocationId);
    const controller = existing ?? new AbortController();
    if (existing === undefined) {
      if (this.cancelled) controller.abort(new Error(`Execution cancelled: ${this.executionId}`));
      this.invocationSignals.set(invocationId, controller);
    }
    if (parentInvocationId === undefined || parentInvocationId === invocationId) {
      return controller.signal;
    }
    const signal = AbortSignal.any([
      controller.signal,
      this.signalForInvocation(parentInvocationId),
    ]);
    this.linkedInvocationSignals.set(invocationId, signal);
    return signal;
  }

  async acquireRuntime(
    identity: RuntimeSessionIdentity,
    create: (options: RuntimeSessionCreateOptions) => Promise<RuntimeAgentSession>,
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
    supportsSteer: boolean,
  ): void {
    const submission = { invocationId, contextId, session, handle, supportsSteer };
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
    while (true) {
      const execution = await requireExecution(this.store, this.executionId);
      const invocation = await this.store.getInvocation(this.executionId, invocationId);
      if (invocation === undefined) throw new Error(`Invocation not found: ${invocationId}`);
      if (isTerminalExecutionStatus(invocation.status)) return false;
      const agent =
        invocation.agentId === undefined
          ? undefined
          : await this.store.getAgent(this.executionId, invocation.agentId);
      try {
        await this.store.commit({
          commitId: `invocation-interrupted:${invocationId}`,
          executionId: this.executionId,
          expectedVersion: execution.version,
          invocationPatches: [
            {
              invocationId,
              patch: {
                status: "interrupted",
                waitReason: undefined,
                pendingExpertMessages: [],
                error: reason,
              },
            },
          ],
          ...(agent?.activeInvocationId !== invocation.invocationId
            ? {}
            : {
                agentPatches: [
                  { agentId: agent.agentId, patch: { activeInvocationId: undefined } },
                ],
              }),
          events: [
            ...(invocation.pendingExpertMessages.length === 0
              ? []
              : [
                  {
                    invocationId,
                    type: "expert.message.consumed",
                    data: {
                      messageIds: invocation.pendingExpertMessages.map(
                        (message) => message.messageId,
                      ),
                      terminalReason: "interrupted",
                    },
                  },
                ]),
            { invocationId, type: "invocation.interrupted", data: { reason } },
          ],
        });
        break;
      } catch (error) {
        if (error instanceof ExecutionVersionConflictError) continue;
        if (error instanceof ExecutionFinalStatusConflictError) return false;
        throw error;
      }
    }
    const controller = this.invocationSignals.get(invocationId) ?? new AbortController();
    this.invocationSignals.set(invocationId, controller);
    controller.abort(new Error(reason ?? `Invocation interrupted: ${invocationId}`));
    await this.activeRuntimeSubmissions.get(invocationId)?.handle.cancel();
    return true;
  }

  async interruptInvocationTree(invocationId: string, reason?: string): Promise<void> {
    const descendants = await this.invocationTreeIds(invocationId);
    for (const [interactionId, pending] of this.pendingInteractions) {
      if (!descendants.has(pending.invocationId)) continue;
      this.pendingInteractions.delete(interactionId);
      pending.reject(new Error(reason ?? `Invocation interrupted: ${invocationId}`));
    }
    await Promise.allSettled(
      [...descendants].reverse().map(async (id) => await this.interruptInvocation(id, reason)),
    );
  }

  async abortInvocationTree(invocationId: string, reason?: string | Error): Promise<void> {
    const descendants = await this.invocationTreeIds(invocationId);
    const error =
      reason instanceof Error ? reason : new Error(reason ?? `Invocation aborted: ${invocationId}`);
    for (const id of descendants) {
      const controller = this.invocationSignals.get(id) ?? new AbortController();
      this.invocationSignals.set(id, controller);
      controller.abort(error);
    }
    for (const [interactionId, pending] of this.pendingInteractions) {
      if (!descendants.has(pending.invocationId)) continue;
      this.pendingInteractions.delete(interactionId);
      pending.reject(error);
    }
    await Promise.allSettled(
      [...descendants].map(
        async (id) => await this.activeRuntimeSubmissions.get(id)?.handle.cancel(),
      ),
    );
  }

  private async invocationTreeIds(invocationId: string): Promise<Set<string>> {
    const invocations = await this.store.listInvocations(this.executionId);
    const descendants = new Set([invocationId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const invocation of invocations) {
        if (
          invocation.parentInvocationId !== undefined &&
          descendants.has(invocation.parentInvocationId) &&
          !descendants.has(invocation.invocationId)
        ) {
          descendants.add(invocation.invocationId);
          changed = true;
        }
      }
    }
    return descendants;
  }

  async requestHumanInteraction(
    invocationId: string,
    request: ExpertAgentHumanRequest,
    requestedInteractionId?: string,
  ): Promise<ExpertAgentHumanResponse> {
    if (this.cancelled) throw new Error("Execution was cancelled.");
    const signal = this.signalForInvocation(invocationId);
    if (signal.aborted) throw signal.reason ?? new Error("Invocation was aborted.");
    const parsedRequest = ExpertAgentHumanRequestSchema.parse(request);
    const recoverable = (await this.recoverableInteractions).find((interaction) =>
      sameHumanRequest(interaction.request, parsedRequest),
    );
    const interactionId = recoverable?.interactionId ?? requestedInteractionId ?? randomUUID();
    if (recoverable !== undefined) {
      const interactions = await this.recoverableInteractions;
      interactions.splice(interactions.indexOf(recoverable), 1);
      const restoredResponse = await readHumanInteractionResponse(
        this.store,
        this.executionId,
        interactionId,
      );
      if (restoredResponse !== undefined) {
        await this.store.commit({
          commitId: `human-resumed:${interactionId}`,
          executionId: this.executionId,
          invocationPatches: [
            { invocationId, patch: { status: "running", waitReason: undefined } },
          ],
          events: [{ invocationId, type: "human.resumed", data: { interactionId } }],
        });
        return restoredResponse;
      }
    } else {
      await this.store.appendEvent(
        this.executionId,
        invocationId,
        "human.requested",
        { interactionId, request: parsedRequest },
        `human-request:${interactionId}`,
      );
    }
    if (this.cancelled) throw new Error("Execution was cancelled.");
    if (signal.aborted) throw signal.reason ?? new Error("Invocation was aborted.");
    const automaticResponse = await this.options.automaticHumanInteractionHandler?.(request);
    if (automaticResponse !== undefined) {
      const requestId = `automatic-human-response:${interactionId}`;
      await this.store.appendEvent(
        this.executionId,
        invocationId,
        "human.responded",
        { interactionId, requestId, response: automaticResponse },
        requestId,
      );
      return automaticResponse;
    }
    await this.store.commit({
      commitId: `human-waiting:${interactionId}`,
      executionId: this.executionId,
      invocationPatches: [
        { invocationId, patch: { status: "waiting", waitReason: "human_input" } },
      ],
      events: [
        {
          invocationId,
          type: "human.waiting",
          data: { interactionId },
        },
      ],
    });
    const response = await new Promise<ExpertAgentHumanResponse>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        if (this.pendingInteractions.get(interactionId) === pending) {
          this.pendingInteractions.delete(interactionId);
        }
      };
      const pending = {
        invocationId,
        resolve: (value: ExpertAgentHumanResponse) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        reject: (reason: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(reason);
        },
      };
      const abort = () =>
        pending.reject(signal.reason ?? new Error(`Invocation aborted: ${invocationId}`));
      this.pendingInteractions.set(interactionId, pending);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void readHumanInteractionResponse(this.store, this.executionId, interactionId).then(
        (persisted) => {
          if (persisted !== undefined) pending.resolve(persisted);
        },
        (error: unknown) => pending.reject(error),
      );
    });
    await this.store.commit({
      commitId: `human-resumed:${interactionId}`,
      executionId: this.executionId,
      invocationPatches: [{ invocationId, patch: { status: "running", waitReason: undefined } }],
      events: [{ invocationId, type: "human.resumed", data: { interactionId } }],
    });
    return response;
  }

  async respond(interactionId: string, response: unknown, requestId: string): Promise<void> {
    const existingOperation = this.humanResponseOperations.get(interactionId);
    if (existingOperation !== undefined) {
      if (existingOperation.requestId === requestId) {
        await existingOperation.promise;
        return;
      }
      throw new Error(`Human interaction idempotency conflict: ${interactionId}`);
    }
    const operation = (async () => {
      const parsedResponse = await persistHumanInteractionResponse(
        this.store,
        this.executionId,
        interactionId,
        response,
        requestId,
      );
      const pending = this.pendingInteractions.get(interactionId);
      if (pending === undefined) return;
      await this.store.commit({
        commitId: `human-resumed:${interactionId}`,
        executionId: this.executionId,
        invocationPatches: [
          {
            invocationId: pending.invocationId,
            patch: { status: "running", waitReason: undefined },
          },
        ],
        events: [
          {
            invocationId: pending.invocationId,
            type: "human.resumed",
            data: { interactionId },
          },
        ],
      });
      this.pendingInteractions.delete(interactionId);
      pending.resolve(parsedResponse);
    })();
    this.humanResponseOperations.set(interactionId, { requestId, promise: operation });
    try {
      await operation;
    } finally {
      if (this.humanResponseOperations.get(interactionId)?.promise === operation) {
        this.humanResponseOperations.delete(interactionId);
      }
    }
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
      const invocations = (await this.store.listInvocations(this.executionId)).filter(
        (invocation) => !isTerminalExecutionStatus(invocation.status),
      );
      const invocationPatches = invocations.map((invocation) => ({
        invocationId: invocation.invocationId,
        patch: {
          status: "cancelled" as const,
          waitReason: undefined,
          pendingExpertMessages: [],
          error: reason,
        },
      }));
      const closure =
        this.options.closeContextsOnCancel === true
          ? await prepareExecutionContextClosure(this.store, this.executionId)
          : { contextPatches: [], agentPatches: [], events: [] };
      const cancelledInvocationIds = new Set(
        invocations.map((invocation) => invocation.invocationId),
      );
      const activeAgentPatches =
        this.options.closeContextsOnCancel === true
          ? []
          : (await this.store.listAgents(this.executionId))
              .filter(
                (agent) =>
                  agent.activeInvocationId !== undefined &&
                  cancelledInvocationIds.has(agent.activeInvocationId),
              )
              .map((agent) => ({
                agentId: agent.agentId,
                patch: { activeInvocationId: undefined },
              }));
      try {
        await this.store.commit({
          commitId: randomUUID(),
          executionId: this.executionId,
          expectedVersion: record.version,
          executionPatch: { status: "cancelled", error: reason },
          invocationPatches,
          contextPatches: closure.contextPatches,
          agentPatches: [...closure.agentPatches, ...activeAgentPatches],
          events: [
            ...closure.events,
            ...invocations.flatMap((invocation) =>
              invocation.pendingExpertMessages.length === 0
                ? []
                : [
                    {
                      invocationId: invocation.invocationId,
                      type: "expert.message.consumed",
                      data: {
                        messageIds: invocation.pendingExpertMessages.map(
                          (message) => message.messageId,
                        ),
                        terminalReason: "cancelled",
                      },
                    },
                  ],
            ),
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
    if (
      (await this.orchestrators.get(contextId)?.wakeWait(contextId, {
        kind: "steer",
        requestId: request.requestId,
        content: request.content,
      })) === true
    ) {
      return;
    }
    const submission = await this.waitForRuntimeSubmission(contextId);
    await submission.session.steer(request);
  }

  async steerInvocation(request: {
    readonly invocationId: string;
    readonly contextId: string;
    readonly requestId: string;
    readonly content: string;
  }): Promise<"steered" | "waiting_continuation" | "not_active" | "unsupported"> {
    if (
      (await this.orchestrators.get(request.contextId)?.wakeWait(request.contextId, {
        kind: "steer",
        requestId: request.requestId,
        content: request.content,
      })) === true
    ) {
      return "waiting_continuation";
    }
    const submission = this.activeRuntimeSubmissions.get(request.invocationId);
    if (submission === undefined || submission.contextId !== request.contextId) return "not_active";
    if (!submission.supportsSteer) return "unsupported";
    await submission.session.steer({
      requestId: request.requestId,
      content: request.content,
      targetRunId: submission.handle.runId,
    });
    return "steered";
  }

  registerOrchestrator(contextId: string, orchestrator: ExpertOrchestrator): void {
    this.orchestrators.set(contextId, orchestrator);
  }

  finish(): void {
    this.rejectRuntimeSubmissionWaiters(
      new Error("ExpertTurn completed before its Runtime submission became active."),
    );
    this.activeRuntimeSubmissions.clear();
    this.invocationSignals.clear();
    this.linkedInvocationSignals.clear();
    this.orchestrators.clear();
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

export async function listPendingHumanInteractionIds(
  store: ExecutionStore,
  executionId: string,
): Promise<readonly string[]> {
  return (await readPendingHumanInteractions(store, executionId)).map(
    (interaction) => interaction.interactionId,
  );
}

export async function persistHumanInteractionResponse(
  store: ExecutionStore,
  executionId: string,
  interactionId: string,
  response: unknown,
  requestId: string,
): Promise<ExpertAgentHumanResponse> {
  const execution = await store.get(executionId);
  if (execution === undefined) throw new Error(`Execution not found: ${executionId}`);
  if (isTerminalExecutionStatus(execution.status)) {
    throw new Error(`Human interaction is not pending: ${interactionId}`);
  }
  const events = await store.readEvents(executionId);
  const responded = events.find(
    (event) =>
      event.type === "human.responded" &&
      (event.data as { interactionId?: unknown }).interactionId === interactionId,
  );
  if (responded !== undefined) {
    if ((responded.data as { requestId?: unknown }).requestId === requestId) {
      return ExpertAgentHumanResponseSchema.parse(
        (responded.data as { response?: unknown }).response,
      );
    }
    throw new Error(`Human interaction idempotency conflict: ${interactionId}`);
  }
  const requested = events.find(
    (event) =>
      event.type === "human.requested" &&
      (event.data as { interactionId?: unknown }).interactionId === interactionId,
  );
  if (requested === undefined) {
    throw new Error(`Human interaction is not pending: ${interactionId}`);
  }
  const parsedResponse = ExpertAgentHumanResponseSchema.parse(response);
  await store.appendEvent(
    executionId,
    requested.invocationId,
    "human.responded",
    { interactionId, requestId, response: parsedResponse },
    requestId,
  );
  return parsedResponse;
}

async function readPendingHumanInteractions(
  store: ExecutionStore,
  executionId: string,
): Promise<StoredHumanInteraction[]> {
  const events = await store.readEvents(executionId);
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => String((event.data as { interactionId?: unknown }).interactionId ?? "")),
  );
  return events.flatMap((event): StoredHumanInteraction[] => {
    if (event.type !== "human.requested") return [];
    const data = event.data as { interactionId?: unknown; request?: unknown };
    const interactionId = String(data.interactionId ?? "");
    if (interactionId === "" || responded.has(interactionId)) return [];
    const request = ExpertAgentHumanRequestSchema.safeParse(data.request);
    return request.success
      ? [{ interactionId, invocationId: event.invocationId, request: request.data }]
      : [];
  });
}

async function readHumanInteractionsById(
  store: ExecutionStore,
  executionId: string,
  interactionIds: readonly string[],
): Promise<StoredHumanInteraction[]> {
  const expected = new Set(interactionIds);
  return (await store.readEvents(executionId)).flatMap((event): StoredHumanInteraction[] => {
    if (event.type !== "human.requested") return [];
    const data = event.data as { interactionId?: unknown; request?: unknown };
    const interactionId = String(data.interactionId ?? "");
    if (!expected.has(interactionId)) return [];
    const request = ExpertAgentHumanRequestSchema.safeParse(data.request);
    return request.success
      ? [{ interactionId, invocationId: event.invocationId, request: request.data }]
      : [];
  });
}

async function readHumanInteractionResponse(
  store: ExecutionStore,
  executionId: string,
  interactionId: string,
): Promise<ExpertAgentHumanResponse | undefined> {
  const responded = (await store.readEvents(executionId)).find(
    (event) =>
      event.type === "human.responded" &&
      (event.data as { interactionId?: unknown }).interactionId === interactionId,
  );
  return responded === undefined
    ? undefined
    : ExpertAgentHumanResponseSchema.parse((responded.data as { response?: unknown }).response);
}

export interface RunExpertInvocationOptions {
  readonly executionId: string;
  readonly invocationId: string;
  readonly parentInvocationId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly expert: ExpertDefinition;
  readonly prompt: string;
  readonly attachments?: readonly ExpertPromptAttachment[] | undefined;
  readonly owner:
    | { readonly type: "expert-session"; readonly ownerId: string }
    | { readonly type: "flow-execution"; readonly ownerId: string };
  readonly runtimeByExpert?: RuntimeByExpert | undefined;
  readonly context: RuntimeContextRecord;
  readonly controller: ExecutionController;
  readonly store: ExecutionStore;
  readonly runtimes: RuntimeResolver;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly usageSink?: UsageSink | undefined;
  readonly modelSelection?: RuntimeModelSelection | undefined;
  readonly output?: import("../runtime/runtime-adapter.ts").RuntimeOutputSchema | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly runtimeRunId?: string | undefined;
  readonly team?: ExpertTeam | undefined;
  readonly depth?: number | undefined;
  readonly persistContext?: ((context: RuntimeContextRecord) => Promise<void>) | undefined;
  readonly readContextScope?: ContextResolutionScopeReader | undefined;
  readonly orchestrator?: ExpertOrchestrator | undefined;
  readonly delegationPermit?: DelegationPermit | undefined;
  readonly contextOutputs?: ContextOutputService | undefined;
  readonly hostContextBindings?: HostContextBindings | undefined;
  readonly resolveHostContextBindings?: HostContextBindingsResolver | undefined;
}

export async function runExpertInvocation(options: RunExpertInvocationOptions): Promise<unknown> {
  const execution = await requireExecution(options.store, options.executionId);
  const team = isExpertTeam(options.expert) ? options.expert : options.team;
  const nativeExpert = isExpertTeam(options.expert) ? options.expert.coordinator : options.expert;
  const depth = options.depth ?? 0;
  const teamTools = team === undefined ? [] : createTeamDelegationTools(team, nativeExpert.id);
  const delegatedExpert =
    team === undefined ? nativeExpert : withTeamDelegationTools(nativeExpert, teamTools, team);
  const hostContextBindings =
    options.resolveHostContextBindings === undefined
      ? options.hostContextBindings
      : await options.resolveHostContextBindings();
  const invocationOptions: RunExpertInvocationOptions =
    options.resolveHostContextBindings === undefined
      ? options
      : {
          ...options,
          hostContextBindings,
          resolveHostContextBindings: undefined,
        };
  const executableExpert = withHostContextBindings(delegatedExpert, hostContextBindings);
  const contextOutputs =
    options.contextOutputs ??
    new ContextOutputService(options.executionId, executableExpert.contextSystem);
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
      rootInvocationId: execution.rootInvocationId,
      scopeInvocationId: options.invocationId,
      store: options.store,
      maxConcurrency: delegation.maxConcurrency,
      maxDepth: delegation.maxDepth,
      interruptController: options.controller,
      execute: async (job): Promise<void> =>
        await executeAgentJob(invocationOptions, team, created, job),
      ...(options.readContextScope === undefined
        ? {}
        : { readContextScope: options.readContextScope }),
      ...(options.persistContext === undefined ? {} : { persistContext: options.persistContext }),
    });
    orchestrator = created;
  }
  if (orchestrator !== undefined && delegation !== undefined) {
    await orchestrator.registerExperts(
      team === undefined ? delegation.experts : [team.coordinator, ...team.members],
    );
    options.controller.registerOrchestrator(options.context.contextId, orchestrator);
  }

  const invocation = await requireInvocation(
    options.store,
    options.executionId,
    options.invocationId,
  );
  const interactionAccess = {
    ownerContextId: options.context.contextId,
    callerInvocationId: options.invocationId,
    ...(options.agentId === undefined ? {} : { callerAgentId: options.agentId }),
    callerDepth: options.depth ?? 0,
    spawnExpertIds: delegation?.spawnExpertIds ?? new Set<string>(),
    interactExpertIds: delegation?.interactExpertIds ?? new Set<string>(),
    isCoordinator: delegation?.isCoordinator ?? false,
  };
  if (invocation.status === "succeeded") {
    options.controller.addUsage(invocation.usage);
    return invocation.output;
  }
  options.controller.addUsage(invocation.usage);
  await options.store.commit({
    commitId: `invocation-started:${options.invocationId}:${randomUUID()}`,
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
  const formattedPrompt = formatExpertPromptWithAttachments(
    options.prompt,
    options.attachments ?? [],
  );
  await appendUserMessage(
    options,
    formattedPrompt,
    `invocation-user-message:${options.invocationId}`,
  );
  const invocationSignal = options.controller.signalForInvocation(
    options.invocationId,
    options.parentInvocationId,
  );
  throwIfAborted(invocationSignal, options.invocationId);

  const modelSelection = options.modelSelection ?? options.context.modelSelection;
  const resolvedRuntime = await options.runtimes.resolve({
    binding: options.context.runtime,
    modelSelection,
  });
  const runtime = resolvedRuntime.adapter;
  await validateDelegatedRuntimeRouting(options, delegation, runtime.descriptor.id);
  const runtimeIdentity = {
    contextId: options.context.contextId,
    expertId: nativeExpert.id,
    runtime: options.context.runtime,
    hostContextBindingsFingerprint: hostContextBindingsFingerprint(hostContextBindings),
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
    invocationOptions,
    nativeExpert,
    team,
    delegation,
    orchestrator,
    depth,
    runtime.descriptor.id,
  );
  const humanInteractionHandler = async (request: ExpertAgentHumanRequest) => {
    const resumeDelegation = options.delegationPermit?.suspend();
    try {
      return await options.controller.requestHumanInteraction(options.invocationId, request);
    } finally {
      await resumeDelegation?.({ allowOvercommit: true });
    }
  };
  const invocationLoggerProvider = options.loggerProvider?.withScope({
    executionId: options.executionId,
    invocationId: options.invocationId,
    contextId: options.context.contextId,
    agentId: nativeExpert.id,
  });
  const session = await options.controller.acquireRuntime(runtimeIdentity, async ({ fresh }) => {
    const opened = await openRuntimeSession(runtime, {
      agent: executableExpert,
      owner:
        options.owner.type === "expert-session"
          ? { ...options.owner, contextId: options.context.contextId }
          : {
              ...options.owner,
              invocationId: requireInvocationContextOrigin(options.context),
            },
      ...(fresh
        ? {}
        : {
            systemSessionId: options.context.snapshot?.systemSessionId,
            runtimeSession: options.context.snapshot?.runtimeSession,
          }),
      context: {
        source: executionRootSource(execution.definition),
        attributes: {
          [EXECUTION_ID_ATTR]: options.executionId,
          [INVOCATION_ID_ATTR]: options.invocationId,
          [EXECUTION_CURRENT_EXPERT_ID_ATTR]: nativeExpert.id,
          [EXECUTION_CONTEXT_ID_ATTR]: options.context.contextId,
        },
      },
      executionContext,
      humanInteractionHandler,
      modelSelection,
      loggerProvider: invocationLoggerProvider,
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

  const recoveredMessages =
    invocation.waitReason === "human_input"
      ? []
      : await orchestrator?.readPendingMessages(options.invocationId);
  let activeExpertMessages = recoveredMessages ?? [];
  let query =
    activeExpertMessages.length > 0
      ? formatExpertMessageContinuation(activeExpertMessages)
      : formattedPrompt;
  let continuation = activeExpertMessages.length > 0 ? 1 : 0;
  if (continuation > 0) {
    await appendUserMessage(
      options,
      query,
      expertMessageHandoffEventId(options.invocationId, activeExpertMessages),
      expertMessageHandoffTimestamp(activeExpertMessages),
    );
  }
  let invocationUsage = invocation.usage;
  try {
    invocationLoop: while (true) {
      const turn = await submitRuntimeTurn({
        options,
        invocation,
        session,
        query,
        attachments: continuation === 0 ? (options.attachments ?? []) : [],
        runId:
          continuation === 0
            ? (options.runtimeRunId ?? options.invocationId)
            : `${options.runtimeRunId ?? options.invocationId}:continuation:${
                activeExpertMessages.length > 0
                  ? expertMessageBatchId(activeExpertMessages)
                  : continuation
              }`,
        executionContext,
        humanInteractionHandler,
        modelSelection,
        output: options.output,
        outputRetryLimit: options.outputRetryLimit,
        runtimeSource: runtime.descriptor,
        supportsSteer: isRuntimeFeatureEnabled(runtime.features.steering),
      });
      invocationUsage = mergeUsage(invocationUsage, turn.usage);
      await persistSessionInfo(session, persistRuntimeSnapshot);
      await orchestrator?.acknowledgePendingMessages(
        options.invocationId,
        activeExpertMessages.map((message) => message.messageId),
      );
      activeExpertMessages = [];

      const pendingMessages = await orchestrator?.readPendingMessages(options.invocationId);
      if (pendingMessages !== undefined && pendingMessages.length > 0) {
        await appendInvocationFinalMessage(options, turn.runId, turn.finalMessage, undefined);
        activeExpertMessages = pendingMessages;
        query = formatExpertMessageContinuation(pendingMessages);
        continuation += 1;
        await appendUserMessage(
          options,
          query,
          expertMessageHandoffEventId(options.invocationId, activeExpertMessages),
          expertMessageHandoffTimestamp(activeExpertMessages),
        );
        continue;
      }

      if (
        orchestrator !== undefined &&
        (await orchestrator.hasOwnedUnjoined(options.invocationId))
      ) {
        await appendInvocationFinalMessage(options, turn.runId, turn.finalMessage, undefined);
        const waitResult = await orchestrator.waitForOwnedUnjoined(
          options.invocationId,
          interactionAccess,
          options.controller.signalForInvocation(options.invocationId),
          options.delegationPermit,
          AUTOMATIC_EXPERT_WAIT_TIMEOUT_MS,
          async () => {
            await options.store.commit({
              commitId: randomUUID(),
              executionId: options.executionId,
              invocationPatches: [
                {
                  invocationId: options.invocationId,
                  patch: {
                    status: "waiting",
                    waitReason: "experts",
                    ...(invocationUsage === undefined ? {} : { usage: invocationUsage }),
                  },
                },
              ],
              events: [
                {
                  invocationId: options.invocationId,
                  type: "expert.children.waiting",
                  data: {},
                },
              ],
            });
          },
        );
        const result = {
          completed: waitResult.completed,
          pending: waitResult.pending,
          discovery: await orchestrator.list(interactionAccess),
        };
        const waitMessages =
          waitResult.wakeReason === "message"
            ? await orchestrator.readPendingMessages(options.invocationId)
            : [];
        activeExpertMessages = waitMessages;
        query =
          waitMessages.length > 0
            ? formatExpertMessageContinuation(waitMessages, result)
            : waitResult.wakeReason === "steer" && waitResult.steer !== undefined
              ? [
                  "[Pragma orchestration steer]",
                  "The user sent new guidance while you were waiting for attached Expert tasks.",
                  "The pending Expert tasks continue running. Handle the guidance now, then call wait_experts again when appropriate.",
                  `User guidance: ${waitResult.steer.content}`,
                  JSON.stringify(result, null, 2),
                ].join("\n")
              : waitResult.timedOut
                ? [
                    "[Pragma orchestration wait timeout]",
                    "The bounded wait ended, but the listed Expert tasks are still running.",
                    "Review the pending state now. Call wait_experts again, steer_expert, or interrupt_expert as appropriate. Do not spawn duplicate work.",
                    JSON.stringify(result, null, 2),
                  ].join("\n")
                : [
                    "[Pragma orchestration continuation]",
                    "All attached Expert tasks are terminal. Synthesize their results into the final answer.",
                    "Do not spawn replacement tasks for work that is already complete.",
                    JSON.stringify(result, null, 2),
                  ].join("\n");
        continuation += 1;
        await options.store.commit({
          commitId: randomUUID(),
          executionId: options.executionId,
          invocationPatches: [
            {
              invocationId: options.invocationId,
              patch: { status: "running", waitReason: undefined },
            },
          ],
          events: [
            {
              invocationId: options.invocationId,
              type:
                waitMessages.length > 0
                  ? "expert.children.message-received"
                  : waitResult.wakeReason === "steer"
                    ? "expert.children.wait-steered"
                    : waitResult.timedOut
                      ? "expert.children.wait-timed-out"
                      : "expert.children.completed",
              data: result,
            },
          ],
        });
        await appendUserMessage(
          options,
          query,
          activeExpertMessages.length > 0
            ? expertMessageHandoffEventId(options.invocationId, activeExpertMessages)
            : `invocation-continuation-message:${options.invocationId}:${continuation}`,
          activeExpertMessages.length > 0
            ? expertMessageHandoffTimestamp(activeExpertMessages)
            : undefined,
        );
        continue;
      }

      const invocationOutput = await contextOutputs.normalize(
        options.invocationId,
        options.context.contextId,
        turn.output,
      );
      await appendInvocationFinalMessage(options, turn.runId, turn.finalMessage, invocationOutput);
      while (true) {
        const currentExecution = await requireExecution(options.store, options.executionId);
        const currentInvocation = await options.store.getInvocation(
          options.executionId,
          options.invocationId,
        );
        if (currentInvocation === undefined) {
          throw new Error(`Invocation not found: ${options.invocationId}`);
        }
        if (currentInvocation.pendingExpertMessages.length > 0) {
          const messages = await orchestrator?.readPendingMessages(options.invocationId);
          if (messages !== undefined && messages.length > 0) {
            activeExpertMessages = messages;
            query = formatExpertMessageContinuation(messages);
            continuation += 1;
            await appendUserMessage(
              options,
              query,
              expertMessageHandoffEventId(options.invocationId, activeExpertMessages),
              expertMessageHandoffTimestamp(activeExpertMessages),
            );
            continue invocationLoop;
          }
        }
        try {
          await options.store.commit({
            commitId: `invocation-succeeded:${options.invocationId}`,
            executionId: options.executionId,
            expectedVersion: currentExecution.version,
            invocationPatches: [
              {
                invocationId: options.invocationId,
                patch: {
                  status: "succeeded",
                  waitReason: undefined,
                  output: invocationOutput,
                  ...(invocationUsage === undefined ? {} : { usage: invocationUsage }),
                },
              },
            ],
            ...(options.agentId === undefined
              ? {}
              : {
                  agentPatches: [
                    { agentId: options.agentId, patch: { activeInvocationId: undefined } },
                  ],
                }),
            events: [
              {
                invocationId: options.invocationId,
                type: "invocation.succeeded",
                data: {
                  output: invocationOutput,
                  ...(invocationUsage === undefined ? {} : { usage: invocationUsage }),
                },
              },
            ],
          });
          return invocationOutput;
        } catch (error) {
          if (error instanceof ExecutionVersionConflictError) continue;
          throw error;
        }
      }
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
    while (true) {
      const discardedMessages = await orchestrator?.readPendingMessages(options.invocationId);
      await orchestrator?.acknowledgePendingMessages(
        options.invocationId,
        discardedMessages?.map((message) => message.messageId) ?? [],
        "terminal",
      );
      const currentExecution = await requireExecution(options.store, options.executionId);
      const latest = await options.store.getInvocation(options.executionId, options.invocationId);
      const status = options.controller.isCancelled()
        ? "cancelled"
        : latest?.status === "interrupted"
          ? "interrupted"
          : "failed";
      if (latest === undefined || isTerminalExecutionStatus(latest.status)) break;
      if (latest.pendingExpertMessages.length > 0) continue;
      try {
        await options.store.commit({
          commitId: `invocation-${status}:${options.invocationId}`,
          executionId: options.executionId,
          expectedVersion: currentExecution.version,
          invocationPatches: [
            {
              invocationId: options.invocationId,
              patch: { status, waitReason: undefined, error: serializeError(failure) },
            },
          ],
          ...(options.agentId === undefined
            ? {}
            : {
                agentPatches: [
                  { agentId: options.agentId, patch: { activeInvocationId: undefined } },
                ],
              }),
          events: [
            {
              invocationId: options.invocationId,
              type: `invocation.${status}`,
              data: { message: failure instanceof Error ? failure.message : String(failure) },
            },
          ],
        });
        break;
      } catch (commitError) {
        if (commitError instanceof ExecutionVersionConflictError) continue;
        throw commitError;
      }
    }
    throw failure;
  } finally {
    // Context lifetime is controlled by its owner, not by one Invocation.
  }
}

function executionRootSource(definition: { readonly kind: string; readonly id: string }) {
  const type =
    definition.kind === "expert-team"
      ? "pragma.expert-team"
      : definition.kind === "flow"
        ? "pragma.flow"
        : "pragma.expert";
  return { type, id: definition.id };
}

function formatExpertMessageContinuation(
  messages: Invocation["pendingExpertMessages"],
  waitState?: unknown,
): string {
  return [
    "[Pragma expert message continuation]",
    "The following messages were accepted for this Invocation while it was active.",
    "Incorporate them into the current task before producing the final result.",
    JSON.stringify(
      messages.map((message) => ({
        messageId: message.messageId,
        senderInvocationId: message.senderInvocationId,
        ...(message.senderAgentId === undefined ? {} : { senderAgentId: message.senderAgentId }),
        message: message.content,
      })),
      null,
      2,
    ),
    ...(waitState === undefined
      ? []
      : [
          "Attached Expert tasks may still be running. Handle the messages, then wait again when needed.",
          JSON.stringify(waitState, null, 2),
        ]),
  ].join("\n");
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
    attachments: parent.attachments,
    owner: parent.owner,
    context,
    controller: parent.controller,
    store: parent.store,
    runtimes: parent.runtimes,
    usageSink: parent.usageSink,
    loggerProvider: parent.loggerProvider,
    team,
    depth: await readAgentDepth(parent.store, parent.executionId, job.agent),
    orchestrator,
    delegationPermit: job.permit,
    contextOutputs: parent.contextOutputs,
    hostContextBindings: parent.hostContextBindings,
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
  const base = {
    executionId: options.executionId,
    invocationId: options.invocationId,
    depth,
    invokeResource: async (request: {
      readonly target: unknown;
      readonly input: unknown;
      readonly signal?: AbortSignal | undefined;
    }) => await invokeResourceFromExpert(options, nativeExpert, depth, parentRuntimeId, request),
  };
  if (delegation === undefined || orchestrator === undefined) return base;
  const interactionAccess = {
    ownerContextId: options.context.contextId,
    callerInvocationId: options.invocationId,
    ...(options.agentId === undefined ? {} : { callerAgentId: options.agentId }),
    callerDepth: depth,
    spawnExpertIds: delegation.spawnExpertIds,
    interactExpertIds: delegation.interactExpertIds,
    isCoordinator: delegation.isCoordinator,
  };
  return {
    ...base,
    spawnExpert: async (request: { readonly expertId: string; readonly task: string }) => {
      const expert = delegation.experts.find(
        (candidate) =>
          delegation.spawnExpertIds.has(candidate.id) && candidate.id === request.expertId,
      );
      if (expert === undefined) {
        throw new Error(`Expert ${nativeExpert.id} may not delegate to ${request.expertId}.`);
      }
      const childRuntime = await bindDelegatedRuntime(options, delegation, expert, parentRuntimeId);
      const result = await orchestrator.spawn({
        ownerContextId: options.context.contextId,
        createdByInvocationId: options.invocationId,
        parentAgentId: options.agentId,
        depth,
        expert,
        prompt: request.task,
        runtime: childRuntime,
        modelSelection: expert.models?.default,
        owner: options.owner,
        resolver: freshContextIdResolver,
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
      return {
        expertId: result.expertId,
        contextId: result.contextId,
        agentId: result.agentId,
        invocationId: result.invocationId,
        status: result.status,
      };
    },
    continueExpert: async (request: { readonly contextId: string; readonly task: string }) =>
      await orchestrator.continueContext(interactionAccess, request),
    waitExperts: async (request: {
      readonly invocationIds: readonly string[];
      readonly returnWhen?: "all" | "any" | undefined;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    }) => await orchestrator.wait(interactionAccess, request, options.delegationPermit),
    listAgents: async (request: {
      readonly expertId?: string | undefined;
      readonly status?: "running" | "waiting" | "queued" | "idle" | "resumable" | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    }) => await orchestrator.list(interactionAccess, request),
    steerExpert: async (request: {
      readonly invocationId: string;
      readonly instruction: string;
      readonly delivery: "next_boundary" | "after_current";
    }) => await orchestrator.steer(interactionAccess, request),
    interruptExpert: async (request: {
      readonly invocationId: string;
      readonly reason?: string | undefined;
    }) => await orchestrator.interrupt(interactionAccess, request),
  };
}

async function invokeResourceFromExpert(
  options: RunExpertInvocationOptions,
  caller: Expert,
  depth: number,
  parentRuntimeId: string,
  request: {
    readonly target: unknown;
    readonly input: unknown;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<unknown> {
  if (request.signal?.aborted) throw new Error("Resource call was cancelled.");
  if (depth >= 16) throw new Error("Resource call exceeded the maximum invocation depth (16).");
  if (!isInvocableResource(request.target)) throw new Error("Resource call target is invalid.");
  const target = request.target;
  const execution = await requireExecution(options.store, options.executionId);
  const invocationId = randomUUID();
  const now = new Date().toISOString();
  const unlinkAbort = linkInvocationAbort(request.signal, options.controller, invocationId);

  if (isFlowResource(target)) {
    const invocation: Invocation = {
      invocationId,
      rootInvocationId: execution.rootInvocationId,
      parentInvocationId: options.invocationId,
      nodeId: `tool:${target.id}`,
      definition: { id: target.id, kind: "flow" },
      contextId: invocationId,
      status: "queued",
      pendingExpertMessages: [],
      input: request.input,
      createdAt: now,
      updatedAt: now,
    };
    await options.store.commit({
      commitId: `resource-call-queued:${invocationId}`,
      executionId: options.executionId,
      invocationPuts: [invocation],
      events: [{ invocationId, type: "invocation.queued", data: { resourceCall: true } }],
    });
    await options.store.commit({
      commitId: `resource-call-started:${invocationId}`,
      executionId: options.executionId,
      invocationPatches: [{ invocationId, patch: { status: "running" } }],
      events: [{ invocationId, type: "invocation.started", data: { resourceCall: true } }],
    });
    try {
      const contextOutputs =
        options.contextOutputs ??
        new ContextOutputService(
          options.executionId,
          withHostContextBindings(caller, options.hostContextBindings).contextSystem,
        );
      const output = await runNestedFlowInvocation({
        flow: target,
        executionId: options.executionId,
        flowInvocationId: invocationId,
        input: request.input,
        owner: options.owner,
        controller: options.controller,
        store: options.store,
        runtimes: options.runtimes,
        runtime: parentRuntimeId,
        contextOutputs,
        hostContextBindings: options.hostContextBindings,
        usageSink: options.usageSink,
        loggerProvider: options.loggerProvider,
      });
      const invocationOutput = await contextOutputs.normalize(
        invocationId,
        invocation.contextId,
        output,
      );
      await options.store.commit({
        commitId: `resource-call-succeeded:${invocationId}`,
        executionId: options.executionId,
        invocationPatches: [
          { invocationId, patch: { status: "succeeded", output: invocationOutput } },
        ],
        events: [
          { invocationId, type: "invocation.succeeded", data: { output: invocationOutput } },
        ],
      });
      return unwrapInvocationOutput(invocationOutput);
    } catch (error) {
      await options.store.commit({
        commitId: `resource-call-failed:${invocationId}`,
        executionId: options.executionId,
        invocationPatches: [
          {
            invocationId,
            patch: {
              status: options.controller.isCancelled() ? "cancelled" : "failed",
              error: serializeError(error),
            },
          },
        ],
        events: [
          {
            invocationId,
            type: options.controller.isCancelled() ? "invocation.cancelled" : "invocation.failed",
            data: { error: serializeError(error) },
          },
        ],
      });
      throw error;
    } finally {
      unlinkAbort();
    }
  }

  const nativeTarget = isExpertTeam(target) ? target.coordinator : target;
  const targetModelSelection = nativeTarget.models?.default;
  const targetRuntime = await options.runtimes.bind({
    runtimeId: nativeTarget.defaultRuntimeId ?? parentRuntimeId,
    modelSelection: targetModelSelection,
  });
  const contextResolution = await new ContextResolutionService(options.store).resolve({
    executionId: options.executionId,
    invocationId,
    parentInvocationId: options.invocationId,
    input: request.input,
    state: execution.state,
    source: {
      kind: "expert-delegation",
      callerExpertId: caller.id,
      ...(options.agentId === undefined ? {} : { callerAgentId: options.agentId }),
    },
    owner: options.owner,
    ownerContextId: options.context.contextId,
    expert: { id: nativeTarget.id },
    runtime: targetRuntime.binding,
    modelSelection: targetModelSelection,
    resolver: freshContextIdResolver,
  });
  const invocation: Invocation = {
    invocationId,
    rootInvocationId: execution.rootInvocationId,
    parentInvocationId: options.invocationId,
    nodeId: `tool:${target.id}`,
    definition: {
      id: target.id,
      kind: isExpertTeam(target) ? "expert-team" : "expert",
    },
    executorId: nativeTarget.id,
    contextId: contextResolution.context.contextId,
    contextResolution: {
      resolver: contextResolution.resolver,
      disposition: contextResolution.disposition,
    },
    status: "queued",
    pendingExpertMessages: [],
    input: request.input,
    createdAt: now,
    updatedAt: now,
  };
  await options.store.commit({
    commitId: `resource-call-queued:${invocationId}`,
    executionId: options.executionId,
    invocationPuts: [invocation],
    ...(contextResolution.contextPut === undefined
      ? {}
      : { contextPuts: [contextResolution.contextPut] }),
    events: [
      ...contextResolution.events,
      { invocationId, type: "invocation.queued", data: { resourceCall: true } },
    ],
  });
  try {
    return unwrapInvocationOutput(
      InvocationOutputSchema.parse(
        await runExpertInvocation({
          executionId: options.executionId,
          invocationId,
          parentInvocationId: options.invocationId,
          expert: target,
          prompt: readResourcePrompt(request.input),
          attachments: options.attachments,
          owner: options.owner,
          context: contextResolution.context,
          controller: options.controller,
          store: options.store,
          runtimes: options.runtimes,
          depth: depth + 1,
          contextOutputs: options.contextOutputs,
          hostContextBindings: options.hostContextBindings,
          usageSink: options.usageSink,
          loggerProvider: options.loggerProvider,
          ...(options.readContextScope === undefined
            ? {}
            : { readContextScope: options.readContextScope }),
          ...(options.persistContext === undefined
            ? {}
            : { persistContext: options.persistContext }),
        }),
      ),
    );
  } finally {
    unlinkAbort();
  }
}

function linkInvocationAbort(
  signal: AbortSignal | undefined,
  controller: ExecutionController,
  invocationId: string,
): () => void {
  if (signal === undefined) return () => undefined;
  const abort = () => {
    const reason = signal.reason instanceof Error ? signal.reason : "Resource call aborted.";
    void controller.abortInvocationTree(invocationId, reason);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function isInvocableResource(value: unknown): value is ExpertDefinition | Flow {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    (!("kind" in value) || value.kind === "expert-team" || value.kind === "flow")
  );
}

function isFlowResource(value: ExpertDefinition | Flow): value is Flow {
  return "kind" in value && value.kind === "flow";
}

function readResourcePrompt(input: unknown): string {
  if (typeof input === "string") return input;
  if (
    typeof input === "object" &&
    input !== null &&
    "prompt" in input &&
    typeof input.prompt === "string"
  ) {
    return input.prompt;
  }
  return JSON.stringify(input);
}

async function submitRuntimeTurn(options: {
  readonly options: RunExpertInvocationOptions;
  readonly invocation: Invocation;
  readonly session: RuntimeAgentSession;
  readonly query: string;
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly runId: string;
  readonly executionContext: ReturnType<typeof createExecutionContext>;
  readonly humanInteractionHandler: (
    request: ExpertAgentHumanRequest,
  ) => Promise<ExpertAgentHumanResponse>;
  readonly modelSelection?: RuntimeModelSelection | undefined;
  readonly output?: import("../runtime/runtime-adapter.ts").RuntimeOutputSchema | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly runtimeSource: { readonly id: string; readonly kind: string };
  readonly supportsSteer: boolean;
}): Promise<{
  readonly runId: string;
  readonly output: unknown;
  readonly usage?: AgentMessageUsage | undefined;
  readonly finalMessage?: AgentMessage | undefined;
}> {
  const handle = options.session.submit({
    runId: options.runId,
    query: options.query,
    ...(options.attachments.length === 0 ? {} : { attachments: options.attachments }),
    ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.outputRetryLimit === undefined
      ? {}
      : { outputRetryLimit: options.outputRetryLimit }),
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
    options.supportsSteer,
  );
  const messageAccumulators = new Map<string, RuntimeMessageAccumulator>();
  const accumulatorFor = (runId: string): RuntimeMessageAccumulator => {
    const existing = messageAccumulators.get(runId);
    if (existing !== undefined) return existing;
    const created = new RuntimeMessageAccumulator(options.runtimeSource);
    messageAccumulators.set(runId, created);
    return created;
  };
  const rootMessageAccumulator = accumulatorFor(options.runId);
  let completedRootAssistant: AgentMessage | undefined;
  const liveBus = getExecutionLiveBus(options.options.store);
  let usagePreview = Promise.resolve();
  const drain = (async () => {
    for await (const event of handle.events) {
      const output = projectRuntimeOutput({
        executionId: options.options.executionId,
        invocation: options.invocation,
        event,
      });
      if (output !== undefined) liveBus.publish(options.options.executionId, output);
      if (event.type === "usage.updated" && options.options.usageSink?.preview !== undefined) {
        const observation = createRuntimeUsageObservation(
          options,
          event.payload.usage,
          event.runId,
        );
        usagePreview = usagePreview
          .then(async () => await options.options.usageSink!.preview!(observation))
          .catch((error: unknown) => {
            createUsageSinkLogger(options).warn(
              "usage.sink_preview_failed",
              "Host usage sink rejected a live preview.",
              { observationId: observation.observationId, error },
            );
          });
      }
      for (const message of accumulatorFor(event.runId).consume(event)) {
        if (
          event.runId === options.runId &&
          message.role === "assistant" &&
          message.stopReason !== "toolUse"
        ) {
          completedRootAssistant = message;
          continue;
        }
        await options.options.store.appendEvent(
          options.options.executionId,
          options.options.invocationId,
          "invocation.message.appended",
          {
            message,
            runId: event.runId,
            ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId }),
            source: event.source,
          },
          `invocation-message:${event.eventId}:${message.timestamp}`,
        );
      }
      if (!isLiveOnlyRuntimeEvent(event) && event.type !== "message.completed") {
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
    await usagePreview;
    const output = result.result.output;
    const finalMessage =
      completedRootAssistant ?? rootMessageAccumulator.complete(output, result.result.usage);
    await settleRuntimeTurnUsage(options, result.result.usage);
    return {
      runId: options.runId,
      output,
      usage: result.result.usage,
      ...(finalMessage === undefined ? {} : { finalMessage }),
    };
  } catch (error) {
    const usage = await handle.usage?.catch(() => undefined);
    await usagePreview;
    await settleRuntimeTurnUsage(options, usage);
    throw error;
  } finally {
    await drain.catch(() => undefined);
    options.options.controller.unregisterRuntimeSubmission(
      options.options.invocationId,
      handle.runId,
    );
  }
}

async function settleRuntimeTurnUsage(
  options: Parameters<typeof submitRuntimeTurn>[0],
  usage: AgentMessageUsage | undefined,
): Promise<void> {
  const observationId = runtimeUsageObservationId(
    options.options.executionId,
    options.options.invocationId,
    options.runId,
  );
  if (usage === undefined) {
    await clearRuntimeUsagePreview(options, observationId);
    return;
  }
  options.options.controller.addUsage(usage);
  const current = await options.options.store.getInvocation(
    options.options.executionId,
    options.options.invocationId,
  );
  const invocationUsage = mergeUsage(current?.usage, usage);
  if (current !== undefined && invocationUsage !== undefined) {
    await options.options.store.commit({
      commitId: `invocation-usage:${options.options.invocationId}:${options.runId}`,
      executionId: options.options.executionId,
      invocationPatches: [
        {
          invocationId: options.options.invocationId,
          patch: { usage: invocationUsage },
        },
      ],
    });
  }
  if (options.options.usageSink === undefined) return;
  try {
    await options.options.usageSink.record(
      createRuntimeUsageObservation(options, usage, options.runId),
    );
  } catch (error) {
    createUsageSinkLogger(options).warn(
      "usage.sink_write_failed",
      "Host usage sink rejected an observation.",
      {
        observationId,
        error,
      },
    );
  } finally {
    await clearRuntimeUsagePreview(options, observationId);
  }
}

async function clearRuntimeUsagePreview(
  options: Parameters<typeof submitRuntimeTurn>[0],
  observationId: string,
): Promise<void> {
  try {
    await options.options.usageSink?.clearPreview?.(observationId);
  } catch (error) {
    createUsageSinkLogger(options).warn(
      "usage.sink_preview_clear_failed",
      "Host usage sink failed to clear a live preview.",
      { observationId, error },
    );
  }
}

function createRuntimeUsageObservation(
  options: Parameters<typeof submitRuntimeTurn>[0],
  usage: AgentMessageUsage,
  runId: string,
) {
  const executorId = options.invocation.executorId ?? options.invocation.definition.id;
  return {
    observationId: runtimeUsageObservationId(
      options.options.executionId,
      options.options.invocationId,
      runId,
    ),
    occurredAt: new Date().toISOString(),
    executionId: options.options.executionId,
    invocationId: options.options.invocationId,
    contextId: options.options.context.contextId,
    runId,
    runtimeId: options.options.context.runtime.runtimeId,
    ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
    executor: {
      id: executorId,
      name: readExpertName(options.options.expert, executorId),
    },
    usage,
  };
}

function runtimeUsageObservationId(
  executionId: string,
  invocationId: string,
  runId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([executionId, invocationId, runId]))
    .digest("hex");
}

function createUsageSinkLogger(options: Parameters<typeof submitRuntimeTurn>[0]) {
  return createPragmaLogger(options.options.loggerProvider, {
    component: "usage-sink",
    scope: {
      executionId: options.options.executionId,
      invocationId: options.options.invocationId,
      contextId: options.options.context.contextId,
    },
  });
}

function readExpertName(expert: ExpertDefinition, executorId: string): string {
  if (!isExpertTeam(expert)) return expert.id === executorId ? expert.name : executorId;
  const participant = [expert.coordinator, ...expert.members].find(
    (candidate) => candidate.id === executorId,
  );
  return participant?.name ?? executorId;
}

function isLiveOnlyRuntimeEvent(event: ExpertAgentStreamEvent): boolean {
  return (
    event.type === "message.delta" ||
    event.type === "thought.delta" ||
    event.type === "tool.delta" ||
    event.type === "usage.updated" ||
    event.type === "context-window.updated"
  );
}

function withTeamDelegationTools(
  expert: Expert,
  tools: readonly NonNullable<Expert["tools"]>[number][],
  team?: ExpertTeam | undefined,
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
  const teamContextStores = (team?.contextStores ?? []).filter((binding) =>
    binding.visibility.mode === "all"
      ? true
      : binding.visibility.mode === "whitelist"
        ? binding.visibility.expertIds.includes(expert.id)
        : !binding.visibility.expertIds.includes(expert.id),
  );
  if (team?.instructions !== undefined || teamContextStores.length > 0) {
    const instructionNamespace = `expert-team:${team?.id ?? "unknown"}`;
    const contextSystem = expert.contextSystem.extend({
      roots: [
        ...(team?.instructions === undefined ? [] : [{ namespace: instructionNamespace }]),
        ...teamContextStores.map((binding) => ({ namespace: binding.namespace })),
      ],
      ...(team?.instructions === undefined
        ? {}
        : {
            stores: [
              [
                instructionNamespace,
                new StaticContextStore([
                  {
                    id: "TEAM.md",
                    content: team.instructions,
                    metadata: {
                      description: `Shared instructions for ExpertTeam ${team.name}.`,
                      trigger: "always_on" as const,
                      priority: "critical" as const,
                      trustLevel: "user" as const,
                      sensitivity: "internal" as const,
                    },
                  },
                ]),
              ] as const,
            ],
          }),
    });
    for (const binding of teamContextStores) {
      const registered = contextSystem.register({
        namespace: binding.namespace,
        store: binding.store,
        ...(binding.storeName === undefined ? {} : { storeName: binding.storeName }),
        required: binding.required,
      });
      if (!registered.ok) throw new TypeError(registered.error.message);
    }
    Object.defineProperty(clone, "contextSystem", {
      value: contextSystem,
      enumerable: true,
    });
    Object.defineProperty(clone, "contextManager", {
      value: new ContextManager({ agent: clone, contextSystem }),
    });
  }
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

async function appendInvocationFinalMessage(
  options: RunExpertInvocationOptions,
  runId: string,
  message: AgentMessage | undefined,
  output: InvocationOutput | undefined,
): Promise<void> {
  if (message === undefined) return;
  const persisted =
    output?.type === "context" && message.role === "assistant"
      ? AgentMessageSchema.parse({
          ...message,
          content: [
            ...message.content.filter((item) => item.type !== "text"),
            {
              type: "text",
              text: [
                output.summary,
                "",
                "Full output is available through Context System:",
                ...output.contexts.map(
                  (context) =>
                    `- ${context.namespace}/${context.id} (${context.sizeBytes} bytes, ${context.mediaType})`,
                ),
              ].join("\n"),
            },
          ],
        })
      : message;
  await options.store.appendEvent(
    options.executionId,
    options.invocationId,
    "invocation.message.appended",
    {
      message: persisted,
      runId,
      source: {
        kind: "agent",
        runId,
        agentId: options.expert.id,
        path: [],
      },
    },
    `invocation-final-message:${runId}`,
  );
}

async function appendUserMessage(
  options: RunExpertInvocationOptions,
  content: string,
  eventId: string,
  timestamp = Date.now(),
): Promise<void> {
  await options.store.appendEvent(
    options.executionId,
    options.invocationId,
    "invocation.message.appended",
    { message: { role: "user", content, timestamp } satisfies AgentMessage },
    eventId,
  );
}

function expertMessageBatchId(messages: Invocation["pendingExpertMessages"]): string {
  return createHash("sha256")
    .update(messages.map((message) => message.messageId).join("\0"))
    .digest("hex");
}

function expertMessageHandoffEventId(
  invocationId: string,
  messages: Invocation["pendingExpertMessages"],
): string {
  return `invocation-message-continuation:${invocationId}:${expertMessageBatchId(messages)}`;
}

function expertMessageHandoffTimestamp(messages: Invocation["pendingExpertMessages"]): number {
  return Math.max(...messages.map((message) => Date.parse(message.createdAt)));
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
    !sameRuntimeBinding(options.context.runtime, identity.runtime)
  ) {
    throw new Error(
      `Runtime Context ${options.context.contextId} identity conflicts with ${identity.expertId}/${identity.runtime.runtimeId}@${identity.runtime.revision}.`,
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

async function bindDelegatedRuntime(
  options: RunExpertInvocationOptions,
  delegation: AgentDelegationDefinition,
  expert: Expert,
  parentRuntimeId: string,
): Promise<RuntimeEnvironmentBinding> {
  const configuredRuntimeId =
    options.runtimeByExpert?.[expert.id] ??
    delegation.runtimeByExpert.get(expert.id) ??
    expert.defaultRuntimeId ??
    parentRuntimeId;
  return (
    await options.runtimes.bind({
      runtimeId: configuredRuntimeId,
      modelSelection: expert.models?.default,
    })
  ).binding;
}

async function validateDelegatedRuntimeRouting(
  options: RunExpertInvocationOptions,
  delegation: AgentDelegationDefinition | undefined,
  parentRuntimeId: string,
): Promise<void> {
  if (delegation === undefined) return;
  for (const expert of delegation.experts) {
    await bindDelegatedRuntime(options, delegation, expert, parentRuntimeId);
  }
}

function sameRuntimeBinding(
  left: RuntimeEnvironmentBinding,
  right: RuntimeEnvironmentBinding,
): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.revision === right.revision &&
    left.fingerprint === right.fingerprint
  );
}
