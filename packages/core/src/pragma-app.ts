import type { ExpertDefinition } from "./agent/expert-team.ts";
import {
  ExpertSessionManager,
  type CreateExpertSessionOptions,
  type ExpertSession,
  type ResumeExpertSessionOptions,
} from "./execution/expert-session.ts";
import {
  createFileExpertSessionStore,
  type ExpertSessionStore,
} from "./execution/expert-session-store.ts";
import { createFileExecutionStore, type ExecutionStore } from "./execution/execution-store.ts";
import type { Flow, FlowSpec } from "./flow/flow.ts";
import {
  FlowExecutionManager,
  type FlowExecution,
  type FlowExecutionView,
  type StartFlowRequest,
} from "./flow/flow-execution.ts";
import type { RuntimeResolver } from "./runtime-resolver.ts";
import type { UsageSink } from "./runtime/usage.ts";
import { defaultPragmaLoggerProvider, type PragmaLoggerProvider } from "./logging/logger.ts";
import type { ExpertAgentAutomaticHumanInteractionHandler } from "./tools/managed-tool.ts";
import type {
  HostContextBindings,
  HostContextBindingsResolver,
} from "./context-system/host-context-bindings.ts";

export interface CreatePragmaOptions {
  readonly pragmaHome?: string | undefined;
  readonly runtimes: RuntimeResolver;
  readonly executionStore?: ExecutionStore | undefined;
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
  };
}

export function createPragma(options: CreatePragmaOptions): PragmaApp {
  const loggerProvider = options.loggerProvider ?? defaultPragmaLoggerProvider;
  const executions =
    options.executionStore ??
    createFileExecutionStore(
      options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome },
    );
  const sessions =
    options.expertSessionStore ??
    createFileExpertSessionStore(
      options.pragmaHome === undefined
        ? { executions }
        : { executions, pragmaHome: options.pragmaHome },
    );
  const runtimes = options.runtimes;
  const experts = new ExpertSessionManager({
    sessions,
    executions,
    runtimes,
    loggerProvider,
    pragmaHome: options.pragmaHome,
    automaticHumanInteractionHandler: options.automaticHumanInteractionHandler,
    usageSink: options.usageSink,
    hostContextBindings: options.hostContextBindings,
    resolveHostContextBindings: options.resolveHostContextBindings,
  });
  const flows = new FlowExecutionManager(
    executions,
    runtimes,
    options.automaticHumanInteractionHandler,
    options.pragmaHome,
    loggerProvider,
    options.usageSink,
    options.hostContextBindings,
    options.resolveHostContextBindings,
  );
  return {
    experts: {
      createSession: async (expert, request) => await experts.createSession(expert, request),
      resumeSession: async (expert, request) => await experts.resumeSession(expert, request),
    },
    flows: {
      start: async (flow, request) => await flows.start(flow, request),
      open: async (request) => await flows.open(request),
      recover: async (flow, request) => await flows.recover(flow, request),
    },
  };
}
