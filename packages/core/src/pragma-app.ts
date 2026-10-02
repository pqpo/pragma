import type { ExpertDefinition } from "./agent/expert-team.ts";
import type {
  HostContextBindings,
  HostContextBindingsResolver,
} from "./context-system/host-context-bindings.ts";
import { type ExecutionStore } from "./execution/execution-store.ts";
import type { NestedFlowInvocationExecutor } from "./execution/expert-runner.ts";
import {
  createFileExpertSessionStore,
  type ExpertSessionStore,
} from "./execution/expert-session-store.ts";
import {
  ExpertSessionManager,
  type CreateExpertSessionOptions,
  type ExpertSession,
  type RecoverClosedExpertSessionOptions,
  type ResumeExpertSessionOptions,
} from "./execution/expert-session.ts";
import {
  FlowExecutionManager,
  runNestedFlowInvocation,
  type FlowExecution,
  type FlowExecutionView,
  type StartFlowRequest,
  type StopFlowRequest,
} from "./flow/flow-execution.ts";
import type { Flow, FlowSpec } from "./flow/flow.ts";
import { defaultPragmaLoggerProvider, type PragmaLoggerProvider } from "./logging/logger.ts";
import type { RuntimeResolver } from "./runtime-resolver.ts";
import type { UsageSink } from "./runtime/usage.ts";
import { PragmaPaths } from "./storage/pragma-paths.ts";
import type { ExpertAgentAutomaticHumanInteractionHandler } from "./tools/managed-tool.ts";

export interface CreatePragmaOptions {
  readonly assertExecutionOwnership?: (() => Promise<void>) | undefined;
  readonly pragmaHome?: string | undefined;
  readonly runtimes: RuntimeResolver;
  readonly executionStore: ExecutionStore;
  readonly expertSessionStore?: ExpertSessionStore | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly usageSink?: UsageSink | undefined;
  readonly automaticHumanInteractionHandler?:
    ExpertAgentAutomaticHumanInteractionHandler | undefined;
  readonly hostContextBindings?: HostContextBindings | undefined;
  readonly resolveHostContextBindings?: HostContextBindingsResolver | undefined;
}

export interface PragmaApp {
  readonly experts: {
    createSession(
      expert: ExpertDefinition,
      options?: CreateExpertSessionOptions,
    ): Promise<ExpertSession>;
    resumeSession(
      expert: ExpertDefinition,
      request: ResumeExpertSessionOptions,
    ): Promise<ExpertSession>;
    recoverClosedSession(
      expert: ExpertDefinition,
      request: RecoverClosedExpertSessionOptions,
    ): Promise<ExpertSession>;
  };
  readonly flows: {
    start<TInput>(
      flow: FlowSpec<TInput, unknown> | Flow,
      request: StartFlowRequest<TInput>,
    ): Promise<FlowExecution>;
    open(request: { readonly executionId: string }): Promise<FlowExecutionView>;
    recover(
      flow: FlowSpec | Flow,
      request: { readonly executionId: string; readonly runtime?: string | undefined },
    ): Promise<FlowExecution>;
    stop(flow: FlowSpec | Flow, request: StopFlowRequest): Promise<void>;
  };
}

export function createPragma(options: CreatePragmaOptions): PragmaApp {
  const loggerProvider = options.loggerProvider ?? defaultPragmaLoggerProvider;
  const pragmaHome = new PragmaPaths(
    options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome },
  ).root;
  const storageLogger = loggerProvider.createLogger({ component: "core.storage" });
  const executions = options.executionStore;
  const sessions =
    options.expertSessionStore ??
    createFileExpertSessionStore({ executions, pragmaHome, logger: storageLogger });
  const runtimes = options.runtimes;
  const nestedFlowExecutor: NestedFlowInvocationExecutor = runNestedFlowInvocation;
  const experts = new ExpertSessionManager({
    assertExecutionOwnership: options.assertExecutionOwnership,
    sessions,
    executions,
    runtimes,
    loggerProvider,
    pragmaHome,
    automaticHumanInteractionHandler: options.automaticHumanInteractionHandler,
    usageSink: options.usageSink,
    hostContextBindings: options.hostContextBindings,
    resolveHostContextBindings: options.resolveHostContextBindings,
    nestedFlowExecutor,
  });
  const flows = new FlowExecutionManager(
    executions,
    runtimes,
    options.automaticHumanInteractionHandler,
    pragmaHome,
    loggerProvider,
    options.usageSink,
    options.hostContextBindings,
    options.resolveHostContextBindings,
    options.assertExecutionOwnership,
  );
  return {
    experts: {
      createSession: async (expert, request) => await experts.createSession(expert, request),
      resumeSession: async (expert, request) => await experts.resumeSession(expert, request),
      recoverClosedSession: async (expert, request) =>
        await experts.recoverClosedSession(expert, request),
    },
    flows: {
      start: async (flow, request) => await flows.start(flow, request),
      open: async (request) => await flows.open(request),
      recover: async (flow, request) => await flows.recover(flow, request),
      stop: async (flow, request) => await flows.stop(flow, request),
    },
  };
}
