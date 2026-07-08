import type {
  RunState,
  HumanInteractionOperator,
  HumanInteractionRecord,
  HumanInteractionRequest,
  HumanInteractionResponse,
  MailboxMessage,
  MailboxMessageType,
  SandboxRef,
  TaskRunRecord,
  TaskRunStatus,
  WorkflowRunRecord,
  RunStatus,
} from "@pragma/shared";
import type { z } from "zod";

import type {
  RuntimeAdapter,
  RuntimeOutputSchema,
  RuntimeSessionRef,
} from "../runtime/runtime-adapter.ts";
import type { RuntimeStreamEvent } from "../runtime/stream-events.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";

export type MaybePromise<TValue> = TValue | Promise<TValue>;

export interface Directive<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly inputSchema?: z.ZodType<TInput> | undefined;
  readonly outputSchema?: RuntimeOutputSchema<TOutput> | undefined;
  run(request: StartRunRequest<TInput>): Promise<RunResult<TOutput>>;
}

export interface StepRef<TOutput = unknown> {
  readonly id: string;
  readonly output?: z.ZodType<TOutput> | undefined;
}

export interface RuntimeOverride {
  readonly runtime?: string | undefined;
}

export interface SandboxStrategy {
  readonly mode: "reuse-workflow" | "ephemeral" | "reuse-step" | "attach";
  readonly key?: string | undefined;
  readonly sandboxId?: string | undefined;
}

export interface SandboxRequest {
  readonly strategy?: SandboxStrategy | undefined;
  readonly workspace?:
    | {
        readonly root?: string | undefined;
        readonly access?: "readonly" | "readwrite" | undefined;
      }
    | undefined;
  readonly capabilities?:
    | {
        readonly filesystem?: boolean | undefined;
        readonly shell?: boolean | undefined;
        readonly network?: boolean | undefined;
        readonly humanApproval?: boolean | undefined;
      }
    | undefined;
}

export interface StepReduceContext<TOutput = unknown> {
  readonly state: RunState;
  readonly output: TOutput;
}

export type StepReducer<TOutput = unknown> = (
  context: StepReduceContext<TOutput>,
) => MaybePromise<void>;

export interface StepInputContext {
  readonly state: RunState;
  readonly task: TaskRunRecord;
  readonly workflow: WorkflowRunRecord;
}

export type StepInputResolver<TInput = unknown> = (
  context: StepInputContext,
) => MaybePromise<TInput>;

export interface TaskWorkspace {
  readonly root: string;
  readonly exec: (command: string, options?: TaskWorkspaceExecOptions) => Promise<TaskWorkspaceExecResult>;
}

export interface TaskWorkspaceExecOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface TaskWorkspaceExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TaskContext<TInput = unknown> {
  readonly input: TInput;
  readonly state: RunState;
  readonly workspace: TaskWorkspace;
  readonly task: TaskRunRecord;
  readonly workflow: WorkflowRunRecord;
  readonly sandbox: SandboxRef;
  readonly emitProgress: (event: RuntimeStreamEvent) => Promise<void>;
}

export type TaskHandler<TInput = unknown, TOutput = unknown> = (
  context: TaskContext<TInput>,
) => MaybePromise<TOutput>;

export interface StepDefinition<
  TInput = unknown,
  TOutput = unknown,
> extends RuntimeOverride {
  readonly id: string;
  readonly directive: Directive<TInput, TOutput>;
  readonly input?: StepInputResolver<TInput> | TInput | undefined;
  readonly output?: RuntimeOutputSchema<TOutput> | undefined;
  readonly reduce?: StepReducer<TOutput> | undefined;
  readonly sandbox?: SandboxRequest | undefined;
}

export interface TerminalTarget {
  readonly type: "end" | "fail";
  readonly reason?: string | undefined;
}

export type TransitionTarget = StepRef | TerminalTarget;

export interface NextTransition {
  readonly type: "next";
  readonly from: string;
  readonly to: TransitionTarget;
}

export interface RouteTransition {
  readonly type: "route";
  readonly from: string;
  readonly field: string;
  readonly cases: ReadonlyMap<string, TransitionTarget>;
  readonly fallback?: TransitionTarget | undefined;
}

export type Transition = NextTransition | RouteTransition;

export interface StepLimitPolicy {
  readonly maxVisits?: number | undefined;
  readonly onExceeded?: TerminalTarget | undefined;
}

export interface CompiledDirective<TInput = unknown, TOutput = unknown> extends Directive<TInput, TOutput> {
  readonly id: string;
  readonly inputSchema?: z.ZodType<TInput> | undefined;
  readonly outputSchema?: z.ZodType<TOutput> | undefined;
  readonly resolveOutput?: ((context: { state: RunState }) => TOutput) | undefined;
  readonly steps: ReadonlyMap<string, StepDefinition>;
  readonly startStepId: string;
  readonly transitions: readonly Transition[];
  readonly limits: ReadonlyMap<string, StepLimitPolicy>;
}

export interface StartRunRequest<TInput = unknown> extends RuntimeOverride {
  readonly input: TInput;
  readonly modelName?: string | undefined;
  readonly output?: RuntimeOutputSchema<unknown> | undefined;
  readonly runtimeSession?: RuntimeSessionRef | undefined;
  readonly runtimes?: Readonly<Record<string, string>> | undefined;
  readonly execution?: DirectiveExecutionContext | undefined;
}

export interface RunResult<TOutput = unknown> {
  readonly workflowRunId: string;
  readonly output: TOutput;
  readonly runtimeSession?: RuntimeSessionRef | undefined;
  /**
   * State visible at the boundary of this directive run.
   *
   * Top-level compiled directive runs return the final workflow state after step reducers have applied.
   * When a directive is executed as a step inside an existing workflow, the parent step reducer runs
   * after the child directive returns, so this state may not include the parent reducer's changes.
   */
  readonly state: RunState;
}

export interface DirectiveExecutionContext {
  readonly task: TaskRunRecord;
  readonly workflow: WorkflowRunRecord;
  readonly state: RunState;
  readonly workspace: TaskWorkspace;
  readonly sandbox: SandboxRef;
  readonly runtimeId: string;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly emitProgress: (event: RuntimeStreamEvent) => Promise<void>;
  readonly requestHumanInteraction: (
    request: RequestHumanInteractionInput,
  ) => Promise<HumanInteractionResponse>;
  readonly runDirective: <TInput, TOutput>(
    directive: Directive<TInput, TOutput>,
    request: StartRunRequest<TInput>,
  ) => Promise<RunResult<TOutput>>;
}

export interface RequestHumanInteractionInput {
  readonly request: HumanInteractionRequest;
}

export interface RunHandle<TOutput = unknown> {
  readonly workflowRunId: string;
  readonly result: Promise<RunResult<TOutput>>;
  readonly cancel: (reason?: string) => Promise<void>;
}

export interface TaskLease {
  readonly task: TaskRunRecord;
  readonly workflow: WorkflowRunRecord;
  readonly message: MailboxMessage<TaskDispatchPayload>;
  readonly workerId: string;
}

export interface TaskDispatchPayload {
  readonly taskRunId: string;
  readonly workflowRunId: string;
  readonly directiveId: string;
  readonly stepId: string;
  readonly visit: number;
  readonly input: unknown;
  readonly runtime: {
    readonly requestedId?: string | undefined;
    readonly resolvedId: string;
  };
  readonly sandbox: SandboxRequest;
  readonly policy: TaskPolicy;
}

export interface TaskPolicy {
  readonly timeoutMs?: number | undefined;
}

export interface CreatePragmaOptions {
  readonly mailbox?: Mailbox | undefined;
  readonly stateManager?: StateManager | undefined;
  readonly taskManager?: TaskManager | undefined;
  readonly sandboxManager?: SandboxManager | undefined;
  readonly directiveStore?: DirectiveDefinitionStore | undefined;
  readonly runtimes?: RuntimeRegistry | undefined;
  readonly defaultRuntime?: string | undefined;
}

export interface Pragma {
  readonly mailbox: Mailbox;
  readonly stateManager: StateManager;
  readonly taskManager: TaskManager;
  readonly runtimes: RuntimeRegistry;
  readonly runs: RunObserver;
  readonly start: <TInput, TOutput>(
    directive: DirectiveDefinition<TInput, TOutput>,
    request: StartRunRequest<TInput>,
  ) => Promise<RunHandle<TOutput>>;
  readonly run: <TInput, TOutput>(
    directive: DirectiveDefinition<TInput, TOutput>,
    request: StartRunRequest<TInput>,
  ) => Promise<RunResult<TOutput>>;
}

export interface DirectiveCompiler<TInput = unknown, TOutput = unknown> {
  readonly compile: () => CompiledDirective<TInput, TOutput>;
}

export type DirectiveDefinition<TInput = unknown, TOutput = unknown> =
  | Directive<TInput, TOutput>
  | DirectiveCompiler<TInput, TOutput>;

export interface MailboxSubscriptionFilter {
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly types?: readonly string[] | undefined;
  readonly consumerGroup?: string | undefined;
}

export interface MailboxDeliveryContext {
  readonly ack: () => Promise<void>;
}

export type MailboxMessageHandler = (
  message: MailboxMessage,
  context: MailboxDeliveryContext,
) => MaybePromise<void>;

export interface MailboxSubscription {
  readonly unsubscribe: () => Promise<void>;
}

export interface Mailbox {
  readonly publish: <TPayload>(message: MailboxMessage<TPayload>) => Promise<void>;
  readonly subscribe: (
    filter: MailboxSubscriptionFilter,
    handler: MailboxMessageHandler,
  ) => Promise<MailboxSubscription>;
}

export interface CreateWorkflowRunRequest<TInput = unknown> {
  readonly id: string;
  readonly directiveId: string;
  readonly parentWorkflowRunId?: string | undefined;
  readonly parentTaskRunId?: string | undefined;
  readonly input: TInput;
  readonly state: RunState;
  readonly startStepId: string;
  readonly defaultSandbox: SandboxRef;
}

export interface CreateHumanInteractionRequest {
  readonly workflowRunId: string;
  readonly taskRunId?: string | undefined;
  readonly stepId?: string | undefined;
  readonly request: HumanInteractionRequest;
}

export interface RespondHumanInteractionRequest {
  readonly interactionId: string;
  readonly response: HumanInteractionResponse;
  readonly operator?: HumanInteractionOperator | undefined;
}

export interface ResolveHumanInteractionResult {
  readonly interaction: HumanInteractionRecord;
  readonly duplicate: boolean;
}

export interface CreateTaskRunRequest {
  readonly workflowRunId: string;
  readonly stepId: string;
  readonly visit: number;
  readonly runtimeId: string;
  readonly input: unknown;
}

export interface ApplyStepReductionRequest<TOutput = unknown> {
  readonly workflowRunId: string;
  readonly taskRunId: string;
  readonly stepId: string;
  readonly output: TOutput;
  readonly expectedRevision: number;
  readonly reduce?: StepReducer<TOutput> | undefined;
}

export interface StateTransitionResult {
  readonly workflow: WorkflowRunRecord;
  readonly task?: TaskRunRecord | undefined;
  readonly duplicate: boolean;
}

export interface ReadyTransition {
  readonly stepId: string;
}

export interface StateManager {
  readonly createWorkflowRun: (request: CreateWorkflowRunRequest) => Promise<WorkflowRunRecord>;
  readonly getWorkflowRun: (workflowRunId: string) => Promise<WorkflowRunRecord | undefined>;
  readonly listWorkflowRuns: (
    filter?: ListWorkflowRunsFilter | undefined,
  ) => Promise<readonly WorkflowRunRecord[]>;
  readonly createTaskRun: (request: CreateTaskRunRequest) => Promise<TaskRunRecord>;
  readonly getTaskRun: (taskRunId: string) => Promise<TaskRunRecord | undefined>;
  readonly listTaskRuns: (workflowRunId: string) => Promise<readonly TaskRunRecord[]>;
  readonly markTaskDispatched: (taskRunId: string) => Promise<TaskRunRecord>;
  readonly markTaskLeased: (
    taskRunId: string,
    leaseOwner: string,
    ttlMs: number,
  ) => Promise<TaskRunRecord>;
  readonly renewTaskLease: (
    taskRunId: string,
    leaseOwner: string,
    ttlMs: number,
  ) => Promise<TaskRunRecord>;
  readonly markTaskRunning: (taskRunId: string, sandbox: SandboxRef) => Promise<TaskRunRecord>;
  readonly markTaskWaiting: (taskRunId: string) => Promise<TaskRunRecord>;
  readonly markTaskResumed: (taskRunId: string) => Promise<TaskRunRecord>;
  readonly markTaskSucceeded: (
    taskRunId: string,
    output: unknown,
    metadata?: { readonly runtimeSession?: RuntimeSessionRef | undefined } | undefined,
  ) => Promise<TaskRunRecord>;
  readonly markTaskFailed: (taskRunId: string, error: unknown) => Promise<TaskRunRecord>;
  readonly markTaskCancelled: (
    taskRunId: string,
    reason?: string | undefined,
  ) => Promise<TaskRunRecord>;
  readonly applyTaskEvent: (message: MailboxMessage) => Promise<StateTransitionResult>;
  readonly applyWorkflowEvent: (message: MailboxMessage) => Promise<StateTransitionResult>;
  readonly applyStepReduction: <TOutput>(
    request: ApplyStepReductionRequest<TOutput>,
  ) => Promise<RunState>;
  readonly createHumanInteraction: (
    request: CreateHumanInteractionRequest,
  ) => Promise<HumanInteractionRecord>;
  readonly getHumanInteraction: (
    interactionId: string,
  ) => Promise<HumanInteractionRecord | undefined>;
  readonly listHumanInteractions: (
    workflowRunId: string,
  ) => Promise<readonly HumanInteractionRecord[]>;
  readonly resolveHumanInteraction: (
    request: RespondHumanInteractionRequest,
  ) => Promise<ResolveHumanInteractionResult>;
  readonly markWorkflowWaiting: (workflowRunId: string) => Promise<WorkflowRunRecord>;
  readonly markWorkflowRunning: (workflowRunId: string) => Promise<WorkflowRunRecord>;
  readonly completeWorkflowRun: (
    workflowRunId: string,
    status: "succeeded" | "failed" | "cancelled",
  ) => Promise<WorkflowRunRecord>;
  readonly setCurrentStepIds: (
    workflowRunId: string,
    stepIds: readonly string[],
  ) => Promise<WorkflowRunRecord>;
  readonly listReadyTransitions: (workflowRunId: string) => Promise<readonly ReadyTransition[]>;
  readonly recoverExpiredLeases: (now: Date) => Promise<readonly TaskRunRecord[]>;
}

export interface ListWorkflowRunsFilter {
  readonly directiveId?: string | undefined;
  readonly status?: RunStatus | readonly RunStatus[] | undefined;
  readonly parentWorkflowRunId?: string | null | undefined;
}

export interface RunSummary {
  readonly workflow: WorkflowRunRecord;
  readonly tasks: readonly TaskRunRecord[];
  readonly taskStatusCounts: Readonly<Partial<Record<TaskRunStatus, number>>>;
  readonly childWorkflowRunIds: readonly string[];
}

export interface RunTree extends RunSummary {
  readonly children: readonly RunTree[];
}

export interface RunWatchOptions {
  readonly recursive?: boolean | undefined;
  readonly types?: readonly MailboxMessageType[] | undefined;
  readonly closeOnTerminal?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RunObserver {
  readonly list: (filter?: ListWorkflowRunsFilter | undefined) => Promise<readonly RunSummary[]>;
  readonly get: (workflowRunId: string) => Promise<RunSummary | undefined>;
  readonly getTree: (workflowRunId: string) => Promise<RunTree | undefined>;
  readonly watch: (
    workflowRunId: string,
    options?: RunWatchOptions | undefined,
  ) => AsyncIterable<MailboxMessage>;
  readonly watchOutput: (
    workflowRunId: string,
    options?: Omit<RunWatchOptions, "types"> | undefined,
  ) => AsyncIterable<MailboxMessage>;
}

export interface CreateWorkflowSandboxRequest {
  readonly workflowRunId: string;
  readonly directiveId: string;
  readonly input: unknown;
  readonly request?: SandboxRequest | undefined;
}

export interface ResolveTaskSandboxRequest {
  readonly workflow: WorkflowRunRecord;
  readonly task: TaskRunRecord;
  readonly request: SandboxRequest;
}

export interface SandboxLease {
  readonly ref: SandboxRef;
  readonly workspace: TaskWorkspace;
}

export interface SandboxReleaseResult {
  readonly status: "succeeded" | "failed" | "cancelled";
}

export interface SandboxManager {
  readonly createWorkflowSandbox: (request: CreateWorkflowSandboxRequest) => Promise<SandboxLease>;
  readonly resolveTaskSandbox: (request: ResolveTaskSandboxRequest) => Promise<SandboxLease>;
  readonly releaseTaskSandbox: (lease: SandboxLease, result: SandboxReleaseResult) => Promise<void>;
  readonly cleanupWorkflowSandboxes: (workflowRunId: string) => Promise<void>;
}

export interface DirectiveDefinitionRecord<TInput = unknown, TOutput = unknown> {
  readonly workflowRunId: string;
  readonly directive: CompiledDirective<TInput, TOutput>;
  readonly request: StartRunRequest<TInput>;
}

export interface DirectiveDefinitionStore {
  readonly save: <TInput, TOutput>(record: DirectiveDefinitionRecord<TInput, TOutput>) => Promise<void>;
  readonly get: (workflowRunId: string) => Promise<DirectiveDefinitionRecord | undefined>;
  readonly delete: (workflowRunId: string) => Promise<void>;
}

export interface TaskManager {
  readonly start: () => Promise<void>;
  readonly startRun: <TInput, TOutput>(
    directive: CompiledDirective<TInput, TOutput>,
    request: StartRunRequest<TInput>,
  ) => Promise<RunHandle<TOutput>>;
  readonly handleEvent: (message: MailboxMessage) => Promise<void>;
  readonly dispatchReadyTasks: (workflowRunId: string) => Promise<void>;
  readonly cancelRun: (workflowRunId: string, reason?: string) => Promise<void>;
  readonly leaseTask: (
    message: MailboxMessage<TaskDispatchPayload>,
  ) => Promise<TaskLease | undefined>;
  readonly executeTask: (lease: TaskLease) => Promise<void>;
  readonly respondToHumanInteraction: (
    request: RespondHumanInteractionRequest,
  ) => Promise<HumanInteractionRecord>;
  readonly cancelTask: (taskRunId: string, reason?: string) => Promise<void>;
  readonly recoverExpiredLeases: (now: Date) => Promise<readonly TaskRunRecord[]>;
}

export interface TaskManagerOptions {
  readonly mailbox: Mailbox;
  readonly stateManager: StateManager;
  readonly runtimes: RuntimeRegistry;
  readonly sandboxManager: SandboxManager;
  readonly directiveStore: DirectiveDefinitionStore;
  readonly runDirective?: DirectiveExecutionContext["runDirective"] | undefined;
  readonly workerId?: string | undefined;
  readonly leaseTtlMs?: number | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
}

export type RuntimeLike = RuntimeAdapter;
