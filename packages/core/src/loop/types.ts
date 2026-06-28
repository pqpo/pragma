import type {
  LoopState,
  MailboxMessage,
  TaskEnvironmentRef,
  TaskRunRecord,
  WorkflowRunRecord,
} from "@expertmesh/shared";
import type { z } from "zod";

import type { ExpertAgent } from "../agent/expert-agent.ts";
import type { RuntimeAdapter, RuntimeOutputSchema } from "../runtime/runtime-adapter.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";

export type MaybePromise<TValue> = TValue | Promise<TValue>;

export type LoopStepKind = "agent" | "code" | "subloop";

export interface LoopStepRef<TOutput = unknown> {
  readonly id: string;
  readonly output?: z.ZodType<TOutput> | undefined;
}

export interface LoopRuntimeOverride {
  readonly runtime?: string | undefined;
}

export interface TaskEnvironmentStrategy {
  readonly mode: "local-workspace" | "ephemeral" | "reuse-workflow" | "reuse-step" | "attach";
  readonly key?: string | undefined;
  readonly environmentId?: string | undefined;
}

export interface TaskEnvironmentRequest {
  readonly strategy?: TaskEnvironmentStrategy | undefined;
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

export interface LoopStepReduceContext<TOutput = unknown> {
  readonly state: LoopState;
  readonly output: TOutput;
}

export type LoopStepReducer<TOutput = unknown> = (
  context: LoopStepReduceContext<TOutput>,
) => MaybePromise<void>;

export interface LoopStepInputContext {
  readonly state: LoopState;
  readonly task: TaskRunRecord;
  readonly workflow: WorkflowRunRecord;
}

export type LoopStepInputResolver<TInput = unknown> = (
  context: LoopStepInputContext,
) => MaybePromise<TInput>;

export interface LoopCodeWorkspace {
  readonly root: string;
  readonly exec: (command: string, options?: LoopWorkspaceExecOptions) => Promise<LoopWorkspaceExecResult>;
}

export interface LoopWorkspaceExecOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface LoopWorkspaceExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LoopCodeContext<TInput = unknown> {
  readonly input: TInput;
  readonly state: LoopState;
  readonly workspace: LoopCodeWorkspace;
  readonly task: TaskRunRecord;
  readonly workflow: WorkflowRunRecord;
  readonly environment: TaskEnvironmentRef;
}

export type LoopCodeHandler<TInput = unknown, TOutput = unknown> = (
  context: LoopCodeContext<TInput>,
) => MaybePromise<TOutput>;

export interface BaseLoopStepDefinition<TInput = unknown, TOutput = unknown>
  extends LoopRuntimeOverride {
  readonly id: string;
  readonly kind: LoopStepKind;
  readonly input?: LoopStepInputResolver<TInput> | TInput | undefined;
  readonly output?: RuntimeOutputSchema<TOutput> | undefined;
  readonly reduce?: LoopStepReducer<TOutput> | undefined;
  readonly environment?: TaskEnvironmentRequest | undefined;
}

export interface AgentLoopStepDefinition<TInput = unknown, TOutput = unknown>
  extends BaseLoopStepDefinition<TInput, TOutput> {
  readonly kind: "agent";
  readonly agent: ExpertAgent;
}

export interface CodeLoopStepDefinition<TInput = unknown, TOutput = unknown>
  extends BaseLoopStepDefinition<TInput, TOutput> {
  readonly kind: "code";
  readonly handler: LoopCodeHandler<TInput, TOutput>;
}

export interface SubloopStepDefinition<TInput = unknown, TOutput = unknown>
  extends BaseLoopStepDefinition<TInput, TOutput> {
  readonly kind: "subloop";
  readonly loop: CompiledLoop<TInput, TOutput>;
}

export type LoopStepDefinition<TInput = unknown, TOutput = unknown> =
  | AgentLoopStepDefinition<TInput, TOutput>
  | CodeLoopStepDefinition<TInput, TOutput>
  | SubloopStepDefinition<TInput, TOutput>;

export interface LoopTerminalTarget {
  readonly type: "end" | "fail";
  readonly reason?: string | undefined;
}

export type LoopTransitionTarget = LoopStepRef | LoopTerminalTarget;

export interface LoopNextTransition {
  readonly type: "next";
  readonly from: string;
  readonly to: LoopTransitionTarget;
}

export interface LoopRouteTransition {
  readonly type: "route";
  readonly from: string;
  readonly field: string;
  readonly cases: ReadonlyMap<string, LoopTransitionTarget>;
  readonly fallback?: LoopTransitionTarget | undefined;
}

export type LoopTransition = LoopNextTransition | LoopRouteTransition;

export interface LoopLimitPolicy {
  readonly maxVisits?: number | undefined;
  readonly onExceeded?: LoopTerminalTarget | undefined;
}

export interface CompiledLoop<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly inputSchema?: z.ZodType<TInput> | undefined;
  readonly outputSchema?: z.ZodType<TOutput> | undefined;
  readonly resolveOutput?: ((context: { state: LoopState }) => TOutput) | undefined;
  readonly steps: ReadonlyMap<string, LoopStepDefinition>;
  readonly startStepId: string;
  readonly transitions: readonly LoopTransition[];
  readonly limits: ReadonlyMap<string, LoopLimitPolicy>;
}

export interface StartLoopRunRequest<TInput = unknown> extends LoopRuntimeOverride {
  readonly input: TInput;
  readonly runtimes?: Readonly<Record<string, string>> | undefined;
}

export interface LoopRunResult<TOutput = unknown> {
  readonly workflowRunId: string;
  readonly output: TOutput;
  readonly state: LoopState;
}

export interface WorkflowRunHandle<TOutput = unknown> {
  readonly workflowRunId: string;
  readonly result: Promise<LoopRunResult<TOutput>>;
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
  readonly loopId: string;
  readonly stepId: string;
  readonly visit: number;
  readonly input: unknown;
  readonly runtime: {
    readonly requestedId?: string | undefined;
    readonly resolvedId: string;
  };
  readonly environment: TaskEnvironmentRequest;
  readonly policy: TaskPolicy;
}

export interface TaskPolicy {
  readonly timeoutMs?: number | undefined;
}

export interface CreateLoopAppOptions {
  readonly mailbox?: Mailbox | undefined;
  readonly stateManager?: StateManager | undefined;
  readonly taskManager?: TaskManager | undefined;
  readonly environment?: TaskExecutionEnvironment | undefined;
  readonly runtimes?: RuntimeRegistry | undefined;
  readonly defaultRuntime?: string | undefined;
}

export interface LoopApp {
  readonly mailbox: Mailbox;
  readonly stateManager: StateManager;
  readonly taskManager: TaskManager;
  readonly runtimes: RuntimeRegistry;
  readonly run: <TInput, TOutput>(
    loop: CompiledLoop<TInput, TOutput> | LoopCompiler<TInput, TOutput>,
    request: StartLoopRunRequest<TInput>,
  ) => Promise<LoopRunResult<TOutput>>;
}

export interface LoopCompiler<TInput = unknown, TOutput = unknown> {
  readonly compile: () => CompiledLoop<TInput, TOutput>;
}

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
  readonly loopId: string;
  readonly input: TInput;
  readonly state: LoopState;
  readonly startStepId: string;
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
  readonly reduce?: LoopStepReducer<TOutput> | undefined;
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
  readonly createWorkflowRun: (
    request: CreateWorkflowRunRequest,
  ) => Promise<WorkflowRunRecord>;
  readonly getWorkflowRun: (workflowRunId: string) => Promise<WorkflowRunRecord | undefined>;
  readonly createTaskRun: (request: CreateTaskRunRequest) => Promise<TaskRunRecord>;
  readonly getTaskRun: (taskRunId: string) => Promise<TaskRunRecord | undefined>;
  readonly listTaskRuns: (workflowRunId: string) => Promise<readonly TaskRunRecord[]>;
  readonly markTaskDispatched: (taskRunId: string) => Promise<TaskRunRecord>;
  readonly markTaskLeased: (taskRunId: string, leaseOwner: string) => Promise<TaskRunRecord>;
  readonly markTaskRunning: (
    taskRunId: string,
    environment: TaskEnvironmentRef,
  ) => Promise<TaskRunRecord>;
  readonly markTaskSucceeded: (taskRunId: string, output: unknown) => Promise<TaskRunRecord>;
  readonly markTaskFailed: (taskRunId: string, error: unknown) => Promise<TaskRunRecord>;
  readonly markTaskCancelled: (taskRunId: string, reason?: string | undefined) => Promise<TaskRunRecord>;
  readonly applyTaskEvent: (message: MailboxMessage) => Promise<StateTransitionResult>;
  readonly applyWorkflowEvent: (message: MailboxMessage) => Promise<StateTransitionResult>;
  readonly applyStepReduction: <TOutput>(
    request: ApplyStepReductionRequest<TOutput>,
  ) => Promise<LoopState>;
  readonly completeWorkflowRun: (
    workflowRunId: string,
    status: "succeeded" | "failed" | "cancelled",
  ) => Promise<WorkflowRunRecord>;
  readonly setCurrentStepIds: (
    workflowRunId: string,
    stepIds: readonly string[],
  ) => Promise<WorkflowRunRecord>;
  readonly listReadyTransitions: (workflowRunId: string) => Promise<readonly ReadyTransition[]>;
}

export interface ResolveTaskEnvironmentRequest {
  readonly workflow: WorkflowRunRecord;
  readonly task: TaskRunRecord;
  readonly request: TaskEnvironmentRequest;
}

export interface TaskEnvironmentLease {
  readonly ref: TaskEnvironmentRef;
  readonly workspace: LoopCodeWorkspace;
}

export interface TaskEnvironmentReleaseResult {
  readonly status: "succeeded" | "failed" | "cancelled";
}

export interface TaskExecutionEnvironment {
  readonly resolve: (request: ResolveTaskEnvironmentRequest) => Promise<TaskEnvironmentLease>;
  readonly release: (
    lease: TaskEnvironmentLease,
    result: TaskEnvironmentReleaseResult,
  ) => Promise<void>;
}

export interface TaskManager {
  readonly start: () => Promise<void>;
  readonly startRun: <TInput, TOutput>(
    loop: CompiledLoop<TInput, TOutput>,
    request: StartLoopRunRequest<TInput>,
  ) => Promise<WorkflowRunHandle<TOutput>>;
  readonly handleEvent: (message: MailboxMessage) => Promise<void>;
  readonly dispatchReadyTasks: (workflowRunId: string) => Promise<void>;
  readonly cancelRun: (workflowRunId: string, reason?: string) => Promise<void>;
  readonly leaseTask: (
    message: MailboxMessage<TaskDispatchPayload>,
  ) => Promise<TaskLease | undefined>;
  readonly executeTask: (lease: TaskLease) => Promise<void>;
  readonly cancelTask: (taskRunId: string, reason?: string) => Promise<void>;
  readonly recoverExpiredLeases: (now: Date) => Promise<readonly TaskRunRecord[]>;
}

export interface TaskManagerOptions {
  readonly mailbox: Mailbox;
  readonly stateManager: StateManager;
  readonly runtimes: RuntimeRegistry;
  readonly environment: TaskExecutionEnvironment;
  readonly workerId?: string | undefined;
}

export type RuntimeLike = RuntimeAdapter;
