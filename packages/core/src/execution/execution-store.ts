import {
  type AgentInstance,
  type ExecutionCursor,
  type ExecutionEvent,
  type ExecutionRecord,
  type Invocation,
  type InvocationTree,
  type RuntimeContextRecord,
} from "@pragma/shared";

export const EXECUTION_RECOVERY_CLAIM_STATE_KEY = "__recoveryClaim";

export interface NewExecutionEvent {
  readonly eventId?: string | undefined;
  readonly invocationId: string;
  readonly type: string;
  readonly data: unknown;
  readonly occurredAt?: string | undefined;
}

export interface ExecutionInvocationPatch {
  readonly invocationId: string;
  readonly patch: Partial<Invocation>;
}

export interface ExecutionAgentPatch {
  readonly agentId: string;
  readonly patch: Partial<AgentInstance>;
}

export interface ExecutionContextPatch {
  readonly contextId: string;
  readonly patch: Partial<RuntimeContextRecord>;
}

export interface ExecutionCommitRequest {
  readonly commitId: string;
  readonly executionId: string;
  readonly expectedVersion?: number | undefined;
  readonly recoveryClaimId?: string | undefined;
  readonly executionPatch?: Partial<ExecutionRecord> | undefined;
  readonly invocationPuts?: readonly Invocation[] | undefined;
  readonly invocationPatches?: readonly ExecutionInvocationPatch[] | undefined;
  readonly agentPuts?: readonly AgentInstance[] | undefined;
  readonly agentPatches?: readonly ExecutionAgentPatch[] | undefined;
  readonly contextPuts?: readonly RuntimeContextRecord[] | undefined;
  readonly contextPatches?: readonly ExecutionContextPatch[] | undefined;
  readonly events?: readonly NewExecutionEvent[] | undefined;
}

export interface ExecutionCommitResult {
  readonly execution: ExecutionRecord;
  readonly invocations: readonly Invocation[];
  readonly agents: readonly AgentInstance[];
  readonly contexts: readonly RuntimeContextRecord[];
  readonly events: readonly ExecutionEvent[];
}

export class ExecutionVersionConflictError extends Error {
  constructor(expected: number, received: number) {
    super(`Execution version conflict: expected ${expected}, received ${received}.`);
    this.name = "ExecutionVersionConflictError";
  }
}

export class ExecutionFinalStatusConflictError extends Error {
  constructor(subject: string, current: string, requested: string) {
    super(`${subject} is already ${current} and cannot transition to ${requested}.`);
    this.name = "ExecutionFinalStatusConflictError";
  }
}

export class ExecutionHistoryUnavailableError extends Error {
  constructor(readonly executionId: string) {
    super(`Execution diagnostic history is unavailable: ${executionId}.`);
    this.name = "ExecutionHistoryUnavailableError";
  }
}

export interface ExecutionStore {
  create(record: ExecutionRecord, root: Invocation): Promise<void>;
  get(executionId: string): Promise<ExecutionRecord | undefined>;
  commit(request: ExecutionCommitRequest): Promise<ExecutionCommitResult>;
  claimRecovery(executionId: string, claimId: string, leaseMs: number): Promise<boolean>;
  /** Release only a recovery claim whose execution is durably waiting for human input. */
  releaseWaitingHumanRecovery(executionId: string, claimId: string): Promise<void>;
  getInvocation(executionId: string, invocationId: string): Promise<Invocation | undefined>;
  listInvocations(executionId: string): Promise<readonly Invocation[]>;
  getAgent(executionId: string, agentId: string): Promise<AgentInstance | undefined>;
  listAgents(executionId: string): Promise<readonly AgentInstance[]>;
  getContext(executionId: string, contextId: string): Promise<RuntimeContextRecord | undefined>;
  listContexts(executionId: string): Promise<readonly RuntimeContextRecord[]>;
  getTree(executionId: string): Promise<InvocationTree | undefined>;
  readEvents(
    executionId: string,
    after?: ExecutionCursor,
    limit?: number,
  ): Promise<readonly ExecutionEvent[]>;
  delete(executionId: string): Promise<void>;
  archive(executionId: string): Promise<void>;
}

export interface DurableExecutionStore extends ExecutionStore {
  /** Read without starting a potentially expensive owner conversion. */
  getPrepared?(
    id: string,
  ): Promise<
    { state: "ready"; execution?: ExecutionRecord | undefined } | { state: "requires_preparation" }
  >;
  close?(): Promise<void>;
  /** Drain the durable canonical outbox before the Host closes its event feed. */
  drainCanonicalEvents(): Promise<void>;
  recoverPendingCanonicalEvents(input?: {
    readonly limit?: number | undefined;
  }): Promise<CanonicalEventRecoveryResult>;
  inspectCanonicalEventDelivery(): Promise<CanonicalEventDeliveryStatus>;
  withCanonicalEventDeletion<TValue>(
    executionIds: readonly string[],
    action: (handoffFiles: readonly string[]) => Promise<TValue>,
    expertSessionIds?: readonly string[],
  ): Promise<TValue>;
}

export interface CanonicalEventRecoveryResult {
  readonly recovered: number;
  readonly pending: number;
  readonly failed: number;
  readonly quarantined: number;
}

export interface CanonicalEventDeliveryStatus {
  readonly pending: number;
  readonly quarantined: number;
}
