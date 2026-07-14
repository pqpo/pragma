import { randomUUID } from "node:crypto";

import type {
  AgentMessageUsage,
  ExecutionRecord,
  ExpertSessionRecord,
  ExpertSessionMessage,
  PromptMode,
  PromptRequest,
} from "@pragma/shared";

import type { ExpertDefinition } from "../agent/expert-team.ts";
import { isExpertTeam } from "../agent/expert-team.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";
import { mergeUsages } from "../runtime/usage.ts";
import { ExecutionController, runExpertInvocation } from "./expert-runner.ts";
import type { RuntimeContextSnapshot } from "./expert-runner.ts";
import { RuntimeSessionPool } from "./runtime-session-pool.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { ExpertSessionStore } from "./expert-session-store.ts";
import { StoredExecutionView, type MutableExecution } from "./execution-view.ts";

export interface CreateExpertSessionOptions {
  readonly sessionId?: string | undefined;
  readonly runtime?: string | undefined;
}

export interface PromptOptions {
  readonly requestId?: string | undefined;
  readonly mode?: PromptMode | undefined;
}

export interface ExpertTurn extends MutableExecution {
  readonly requestId: string;
  readonly result: Promise<unknown>;
  readonly usage: Promise<AgentMessageUsage | undefined>;
}

export interface ExpertSession {
  readonly sessionId: string;
  readonly expert: ExpertDefinition;
  prompt(content: string, options?: PromptOptions): Promise<ExpertTurn>;
  abort(reason?: string): Promise<void>;
  close(reason?: string): Promise<void>;
  getState(): Promise<ExpertSessionRecord>;
  listTurns(): Promise<readonly ExpertTurn[]>;
  getMessageHistory(): Promise<readonly ExpertSessionMessage[]>;
  getUsage(): Promise<AgentMessageUsage | undefined>;
  getPromptQueue(): Promise<readonly PromptRequest[]>;
}

export interface ExpertSessionManagerDependencies {
  readonly sessions: ExpertSessionStore;
  readonly executions: ExecutionStore;
  readonly runtimes: RuntimeRegistry;
}

type SteerClaim =
  | { readonly execute: false; readonly executionId: string }
  | {
      readonly execute: true;
      readonly executionId: string;
      readonly contextId: string;
    };

const EXPERT_SESSION_LEASE_MS = 30_000;
const EXPERT_SESSION_LEASE_RENEWAL_MS = 10_000;

export class ExpertSessionManager {
  private readonly active = new Map<string, ExpertSessionImpl>();

  constructor(private readonly dependencies: ExpertSessionManagerDependencies) {}

  async createSession(
    expert: ExpertDefinition,
    options: CreateExpertSessionOptions = {},
  ): Promise<ExpertSession> {
    const sessionId = options.sessionId ?? randomUUID();
    const now = new Date().toISOString();
    const rootExpert = isExpertTeam(expert) ? expert.coordinator : expert;
    await this.dependencies.sessions.create({
      schemaVersion: "pragma.expert-session/v1",
      sessionId,
      expertId: expert.id,
      expertVersion: expert.version,
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      ...(options.runtime === undefined ? {} : { runtimeId: options.runtime }),
      contextIds: { root: randomUUID() },
      runtimeContexts: {},
      createdAt: now,
      updatedAt: now,
    });
    const claimId = randomUUID();
    if (
      !(await this.dependencies.sessions.claimLease(sessionId, claimId, EXPERT_SESSION_LEASE_MS))
    ) {
      throw new Error(`ExpertSession lease could not be acquired: ${sessionId}`);
    }
    const session = this.createActiveSession(expert, sessionId, false, claimId);
    this.active.set(sessionId, session);
    void rootExpert;
    return session;
  }

  async resumeSession(
    expert: ExpertDefinition,
    request: { readonly sessionId: string },
  ): Promise<ExpertSession> {
    const existing = this.active.get(request.sessionId);
    if (existing !== undefined) return existing;
    const record = await this.dependencies.sessions.get(request.sessionId);
    if (record === undefined) throw new Error(`ExpertSession not found: ${request.sessionId}`);
    if (record.status === "closed")
      throw new Error(`ExpertSession is closed: ${request.sessionId}`);
    if (record.expertId !== expert.id || record.expertVersion !== expert.version) {
      throw new Error(`Expert definition mismatch for Session ${request.sessionId}.`);
    }
    const claimId = randomUUID();
    if (
      !(await this.dependencies.sessions.claimLease(
        request.sessionId,
        claimId,
        EXPERT_SESSION_LEASE_MS,
      ))
    ) {
      throw new Error(`ExpertSession is active in another process: ${request.sessionId}`);
    }
    try {
      if (record.activeExecutionId !== undefined) {
        const execution = await this.dependencies.executions.get(record.activeExecutionId);
        if (execution !== undefined && !isTerminal(execution.status)) {
          await this.dependencies.executions.update(execution.executionId, {
            status: "interrupted",
          });
          for (const invocation of await this.dependencies.executions.listInvocations(
            execution.executionId,
          )) {
            if (!isTerminal(invocation.status)) {
              await this.dependencies.executions.putInvocation(execution.executionId, {
                ...invocation,
                status: "interrupted",
                updatedAt: new Date().toISOString(),
              });
            }
          }
        }
        await this.dependencies.sessions.transact(request.sessionId, ({ session, prompts }) => ({
          result: undefined,
          session: {
            ...session,
            activeExecutionId: undefined,
            lastStatus: "interrupted",
            updatedAt: new Date().toISOString(),
          },
          prompts: prompts.map((prompt) =>
            prompt.executionId === record.activeExecutionId && prompt.status === "running"
              ? { ...prompt, status: "interrupted" as const, updatedAt: new Date().toISOString() }
              : prompt,
          ),
        }));
      }
      const session = this.createActiveSession(expert, request.sessionId, true, claimId);
      this.active.set(request.sessionId, session);
      return session;
    } catch (error) {
      await this.dependencies.sessions.releaseLease(request.sessionId, claimId);
      throw error;
    }
  }

  private createActiveSession(
    expert: ExpertDefinition,
    sessionId: string,
    paused: boolean,
    claimId: string,
  ): ExpertSessionImpl {
    const session = new ExpertSessionImpl(
      expert,
      this.dependencies,
      sessionId,
      paused,
      claimId,
      () => {
        if (this.active.get(sessionId) === session) {
          this.active.delete(sessionId);
        }
      },
    );
    return session;
  }
}

class ExpertSessionImpl implements ExpertSession {
  private controller: ExecutionController | undefined;
  private processing: Promise<void> | undefined;
  private readonly runtimeSessions = new RuntimeSessionPool();
  private closePromise: Promise<void> | undefined;
  private leaseRenewalTask: Promise<void> | undefined;
  private leaseError: Error | undefined;
  private readonly leaseRenewal: ReturnType<typeof setInterval>;

  constructor(
    readonly expert: ExpertDefinition,
    private readonly dependencies: ExpertSessionManagerDependencies,
    readonly sessionId: string,
    private paused: boolean,
    private readonly claimId: string,
    private readonly onClosed: () => void,
  ) {
    this.leaseRenewal = setInterval(() => {
      if (this.leaseRenewalTask === undefined) {
        this.leaseRenewalTask = this.renewLease().finally(() => {
          this.leaseRenewalTask = undefined;
        });
      }
    }, EXPERT_SESSION_LEASE_RENEWAL_MS);
    this.leaseRenewal.unref();
  }

  async prompt(content: string, options: PromptOptions = {}): Promise<ExpertTurn> {
    if (this.leaseError !== undefined) throw this.leaseError;
    if (this.closePromise !== undefined) {
      throw new Error(`ExpertSession is closing or closed: ${this.sessionId}`);
    }
    if (content.trim() === "") throw new Error("Prompt content must not be empty.");
    const requestId = options.requestId ?? randomUUID();
    if (requestId.trim() === "") throw new Error("Prompt requestId must not be empty.");
    const mode = options.mode ?? "enqueue";

    if (mode === "steer") return await this.steer(content, requestId);

    const id = randomUUID();
    const now = new Date().toISOString();
    const definitionKind = isExpertTeam(this.expert) ? "expert-team" : "expert";
    const execution: ExecutionRecord = {
      schemaVersion: "pragma.execution/v2",
      executionId: id,
      version: 0,
      kind: "expert-turn",
      definition: { id: this.expert.id, version: this.expert.version, kind: definitionKind },
      rootInvocationId: id,
      status: "queued",
      input: content,
      state: {},
      lastAppliedSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    const prompt: PromptRequest = {
      requestId,
      sessionId: this.sessionId,
      content,
      mode,
      executionId: id,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    const executionId = await this.dependencies.sessions.enqueue({
      execution,
      prompt,
      rootInvocation: {
        invocationId: id,
        rootInvocationId: id,
        definition: execution.definition,
        executorId: isExpertTeam(this.expert) ? this.expert.coordinator.id : this.expert.id,
        status: "queued",
        input: content,
        createdAt: now,
        updatedAt: now,
      },
    });
    this.paused = false;
    this.startProcessing();
    return this.createTurn(executionId, requestId);
  }

  async abort(reason?: string): Promise<void> {
    const controller = this.controller;
    await controller?.cancel(reason);
    await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: { ...session, activeExecutionId: undefined, updatedAt: new Date().toISOString() },
      prompts: prompts.map((prompt) =>
        prompt.executionId === session.activeExecutionId && prompt.status === "running"
          ? { ...prompt, status: "cancelled" as const, updatedAt: new Date().toISOString() }
          : prompt,
      ),
    }));
    this.startProcessing();
  }

  close(reason?: string): Promise<void> {
    if (this.closePromise === undefined) {
      this.paused = true;
      clearInterval(this.leaseRenewal);
      this.runtimeSessions.seal();
      this.closePromise = this.closeInternal(reason);
    }
    return this.closePromise;
  }

  private async closeInternal(reason?: string): Promise<void> {
    const errors: unknown[] = [];
    try {
      const pending = (await this.getPromptQueue()).filter(
        (prompt) => prompt.status === "queued" || prompt.status === "running",
      );
      await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
        result: undefined,
        session: {
          ...session,
          activeExecutionId: undefined,
          queuedRequestIds: [],
          updatedAt: new Date().toISOString(),
        },
        prompts: prompts.map((prompt) =>
          prompt.status === "queued" || prompt.status === "running"
            ? { ...prompt, status: "cancelled" as const, updatedAt: new Date().toISOString() }
            : prompt,
        ),
      }));
      await this.controller?.cancel(reason);
      for (const prompt of pending) {
        const execution = await this.dependencies.executions.get(prompt.executionId);
        if (execution !== undefined && !isTerminal(execution.status)) {
          await this.dependencies.executions.update(prompt.executionId, {
            status: "cancelled",
            error: reason,
          });
          for (const invocation of await this.dependencies.executions.listInvocations(
            prompt.executionId,
          )) {
            if (!isTerminal(invocation.status)) {
              await this.dependencies.executions.putInvocation(prompt.executionId, {
                ...invocation,
                status: "cancelled",
                error: reason,
                updatedAt: new Date().toISOString(),
              });
            }
          }
        }
      }
      await this.processing;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.runtimeSessions.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      try {
        await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
          result: undefined,
          session: { ...session, status: "closed", updatedAt: new Date().toISOString() },
          prompts,
        }));
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.leaseRenewalTask !== undefined) {
      try {
        await this.leaseRenewalTask;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.dependencies.sessions.releaseLease(this.sessionId, this.claimId);
    } catch (error) {
      errors.push(error);
    }
    this.controller = undefined;
    this.onClosed();
    throwCollectedErrors(errors, "ExpertSession close failed.");
  }

  private async renewLease(): Promise<void> {
    if (this.closePromise !== undefined) return;
    try {
      const renewed = await this.dependencies.sessions.claimLease(
        this.sessionId,
        this.claimId,
        EXPERT_SESSION_LEASE_MS,
      );
      if (!renewed) throw new Error(`ExpertSession lease was lost: ${this.sessionId}`);
    } catch (error) {
      this.leaseError = error instanceof Error ? error : new Error(String(error));
      this.paused = true;
      await this.controller?.cancel(this.leaseError.message).catch(() => undefined);
    }
  }

  async getState(): Promise<ExpertSessionRecord> {
    const state = await this.dependencies.sessions.get(this.sessionId);
    if (state === undefined) throw new Error(`ExpertSession not found: ${this.sessionId}`);
    return state;
  }

  async listTurns(): Promise<readonly ExpertTurn[]> {
    const [session, prompts] = await Promise.all([this.getState(), this.getPromptQueue()]);
    const requestIds = new Map(
      prompts
        .filter((prompt) => prompt.mode === "enqueue")
        .map((prompt) => [prompt.executionId, prompt.requestId]),
    );
    return session.executionIds.map((executionId) => {
      const requestId = requestIds.get(executionId);
      if (requestId === undefined) {
        throw new Error(`ExpertTurn prompt is missing: ${executionId}`);
      }
      return this.createTurn(executionId, requestId);
    });
  }

  async getMessageHistory(): Promise<readonly ExpertSessionMessage[]> {
    const prompts = await this.getPromptQueue();
    const session = await this.getState();
    const executions = await Promise.all(
      session.executionIds.map(
        async (executionId) => await this.dependencies.executions.get(executionId),
      ),
    );
    const messages: ExpertSessionMessage[] = prompts.map((prompt) => ({
      role: "user",
      sessionId: this.sessionId,
      executionId: prompt.executionId,
      requestId: prompt.requestId,
      content: prompt.content,
      createdAt: prompt.createdAt,
    }));

    for (const execution of executions) {
      if (execution?.status !== "succeeded") continue;
      messages.push({
        role: "assistant",
        sessionId: this.sessionId,
        executionId: execution.executionId,
        content: execution.output,
        createdAt: execution.updatedAt,
      });
    }

    return messages.sort((left, right) => {
      const timestamp = left.createdAt.localeCompare(right.createdAt);
      if (timestamp !== 0) return timestamp;
      return left.role === right.role ? 0 : left.role === "user" ? -1 : 1;
    });
  }

  async getUsage(): Promise<AgentMessageUsage | undefined> {
    const session = await this.getState();
    const executions = await Promise.all(
      session.executionIds.map(
        async (executionId) => await this.dependencies.executions.get(executionId),
      ),
    );
    return mergeUsages(executions.map((execution) => execution?.usage));
  }

  async getPromptQueue(): Promise<readonly PromptRequest[]> {
    return await this.dependencies.sessions.listPrompts(this.sessionId);
  }

  private async steer(content: string, requestId: string): Promise<ExpertTurn> {
    const controller = this.controller;
    if (controller === undefined) {
      throw new Error("Cannot steer without an active ExpertTurn.");
    }
    const now = new Date().toISOString();
    const claim = await this.dependencies.sessions.transact<SteerClaim>(
      this.sessionId,
      ({ session, prompts }) => {
        if (session.status === "closed") {
          throw new Error(`ExpertSession is closed: ${this.sessionId}`);
        }
        if (session.activeExecutionId === undefined) {
          throw new Error("Cannot steer without an active ExpertTurn.");
        }
        const duplicate = prompts.find((prompt) => prompt.requestId === requestId);
        if (duplicate !== undefined) {
          if (duplicate.content !== content || duplicate.mode !== "steer") {
            throw new Error(`Prompt idempotency conflict: ${requestId}`);
          }
          if (duplicate.status === "failed") {
            throw new Error(duplicate.error ?? `Steer failed: ${requestId}`);
          }
          return {
            result: { execute: false as const, executionId: duplicate.executionId },
            session,
            prompts,
          };
        }
        const contextId = session.contextIds["root"];
        if (contextId === undefined) throw new Error("ExpertSession root context is missing.");
        const executionId = session.activeExecutionId;
        return {
          result: { execute: true as const, executionId, contextId },
          session: { ...session, updatedAt: now },
          prompts: [
            ...prompts,
            {
              requestId,
              sessionId: this.sessionId,
              content,
              mode: "steer" as const,
              executionId,
              targetExecutionId: executionId,
              status: "running" as const,
              createdAt: now,
              updatedAt: now,
            },
          ],
        };
      },
    );
    if (!claim.execute) return this.createTurn(claim.executionId, requestId);
    try {
      const current = await this.getState();
      if (this.controller !== controller || current.activeExecutionId !== claim.executionId) {
        throw new Error(`ExpertTurn changed before steer: ${claim.executionId}`);
      }
      await controller.steer(claim.contextId, {
        requestId,
        content,
        targetRunId: claim.executionId,
      });
      await this.completeSteer(requestId, "succeeded");
      return this.createTurn(claim.executionId, requestId);
    } catch (error) {
      await this.completeSteer(
        requestId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async completeSteer(
    requestId: string,
    status: "succeeded" | "failed",
    error?: string,
  ): Promise<void> {
    await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: { ...session, updatedAt: new Date().toISOString() },
      prompts: prompts.map((prompt) =>
        prompt.requestId === requestId
          ? {
              ...prompt,
              status,
              ...(error === undefined ? {} : { error }),
              updatedAt: new Date().toISOString(),
            }
          : prompt,
      ),
    }));
  }

  private startProcessing(): void {
    if (this.paused || this.processing !== undefined) return;
    this.processing = this.processQueue().finally(() => {
      this.processing = undefined;
    });
  }

  private async processQueue(): Promise<void> {
    while (true) {
      const prompts = await this.getPromptQueue();
      const next = prompts.find((prompt) => prompt.status === "queued");
      if (next === undefined) return;
      await this.runPrompt(next).catch(() => undefined);
    }
  }

  private async runPrompt(prompt: PromptRequest): Promise<void> {
    const now = new Date().toISOString();
    await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: {
        ...session,
        activeExecutionId: prompt.executionId,
        queuedRequestIds: session.queuedRequestIds.filter((id) => id !== prompt.requestId),
        updatedAt: now,
      },
      prompts: prompts.map((candidate) =>
        candidate.requestId === prompt.requestId
          ? { ...candidate, status: "running" as const, updatedAt: now }
          : candidate,
      ),
    }));
    await this.dependencies.executions.commit({
      commitId: randomUUID(),
      executionId: prompt.executionId,
      executionPatch: { status: "running" },
      events: [
        {
          invocationId: prompt.executionId,
          type: "execution.started",
          data: {},
        },
      ],
    });
    const session = await this.getState();
    const rootContextId = session.contextIds["root"]!;
    const contextIds = { ...session.contextIds };
    const runtimeContexts = { ...session.runtimeContexts };
    const controller = new ExecutionController(
      prompt.executionId,
      this.dependencies.executions,
      this.runtimeSessions,
    );
    this.controller = controller;
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let output: unknown;
    let error: unknown;
    try {
      output = await runExpertInvocation({
        executionId: prompt.executionId,
        invocationId: prompt.executionId,
        expert: this.expert,
        prompt: prompt.content,
        owner: { type: "expert-session", ownerId: this.sessionId },
        runtimeId: session.runtimeId,
        contextId: rootContextId,
        runtimeSnapshot: runtimeContexts[rootContextId],
        controller,
        store: this.dependencies.executions,
        runtimes: this.dependencies.runtimes,
        contextForMember: (expertId, policy) => {
          if (policy === "fresh") return { contextId: randomUUID() };
          const contextId = contextIds[expertId] ?? randomUUID();
          contextIds[expertId] = contextId;
          return { contextId, snapshot: runtimeContexts[contextId] };
        },
        onRuntimeContext: async (contextId, snapshot) => {
          runtimeContexts[contextId] = snapshot;
          await this.persistRuntimeContext(contextId, snapshot);
        },
      });
    } catch (caught) {
      error = caught;
      status = controller.isCancelled() ? "cancelled" : "failed";
    }
    const usage = controller.getUsage();
    const executionPatch = {
      status,
      ...(usage === undefined ? {} : { usage }),
      ...(status === "succeeded" ? { output } : { error: serializeError(error) }),
    };
    const currentExecution = await this.dependencies.executions.get(prompt.executionId);
    if (currentExecution !== undefined && isTerminal(currentExecution.status)) {
      if (usage !== undefined) {
        await this.dependencies.executions.update(prompt.executionId, { usage });
      }
      if (
        currentExecution.status === "succeeded" ||
        currentExecution.status === "failed" ||
        currentExecution.status === "cancelled"
      ) {
        status = currentExecution.status;
      }
    } else {
      await this.dependencies.executions.commit({
        commitId: `expert-turn-${status}:${prompt.executionId}`,
        executionId: prompt.executionId,
        executionPatch,
        events: [
          {
            invocationId: prompt.executionId,
            type: `execution.${status}`,
            data:
              status === "succeeded"
                ? { output, ...(usage === undefined ? {} : { usage }) }
                : { error: serializeError(error), ...(usage === undefined ? {} : { usage }) },
          },
        ],
      });
    }
    await this.dependencies.sessions.transact(this.sessionId, ({ session: current, prompts }) => ({
      result: undefined,
      session: {
        ...current,
        activeExecutionId: undefined,
        lastStatus: status,
        updatedAt: new Date().toISOString(),
      },
      prompts: prompts.map((candidate) =>
        candidate.requestId === prompt.requestId
          ? { ...candidate, status, updatedAt: new Date().toISOString() }
          : candidate,
      ),
    }));
    if (this.controller === controller) {
      this.controller = undefined;
    }
    controller.finish();
  }

  private async persistRuntimeContext(
    contextId: string,
    snapshot: RuntimeContextSnapshot,
  ): Promise<void> {
    await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: {
        ...session,
        contextIds: { ...session.contextIds, [snapshot.expertId]: contextId },
        runtimeContexts: { ...session.runtimeContexts, [contextId]: snapshot },
        updatedAt: new Date().toISOString(),
      },
      prompts,
    }));
  }

  private createTurn(executionId: string, requestId: string): ExpertTurn {
    const view = new StoredExecutionView(executionId, this.dependencies.executions);
    const completion = waitForTerminalExecution(this.dependencies.executions, executionId);
    return Object.assign(view, {
      requestId,
      result: completion.then(readExecutionResult),
      usage: completion.then((execution) => execution.usage),
      cancel: async (reason?: string) => {
        const state = await this.getState();
        if (state.activeExecutionId !== executionId || this.controller === undefined) {
          throw new Error(`ExpertTurn is not active: ${executionId}`);
        }
        await this.abort(reason);
      },
      respondToHumanInteraction: async (
        interactionId: string,
        response: unknown,
        options: { readonly requestId: string },
      ) => {
        if (this.controller === undefined) throw new Error("ExpertTurn is not active.");
        await this.controller.respond(interactionId, response, options.requestId);
      },
    });
  }
}

async function waitForTerminalExecution(
  store: ExecutionStore,
  executionId: string,
): Promise<ExecutionRecord> {
  while (true) {
    const record = await store.get(executionId);
    if (record === undefined) throw new Error(`Execution not found: ${executionId}`);
    if (
      record.status === "succeeded" ||
      record.status === "failed" ||
      record.status === "cancelled" ||
      record.status === "interrupted"
    )
      return record;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function readExecutionResult(record: ExecutionRecord): unknown {
  if (record.status === "succeeded") return record.output;
  throw new Error(
    record.error === undefined
      ? `Execution ${record.status}: ${record.executionId}`
      : readErrorMessage(record.error),
  );
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function serializeError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}
