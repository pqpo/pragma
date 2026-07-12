import type { ExpertDefinition } from "./agent/expert-team.ts";
import {
  ExpertSessionManager,
  type CreateExpertSessionOptions,
  type ExpertSession,
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
import {
  createDefaultRuntimeRegistry,
  createDefaultRuntimeRegistryIfConfigured,
} from "./runtime/default-runtime-registry.ts";
import type { RuntimeRegistry } from "./runtime-registry.ts";

export interface CreatePragmaOptions {
  readonly pragmaHome?: string | undefined;
  readonly runtimes?: RuntimeRegistry | undefined;
  readonly executionStore?: ExecutionStore | undefined;
  readonly expertSessionStore?: ExpertSessionStore | undefined;
}

export interface PragmaApp {
  readonly experts: {
    createSession(
      expert: ExpertDefinition,
      options?: CreateExpertSessionOptions,
    ): Promise<ExpertSession>;
    resumeSession(
      expert: ExpertDefinition,
      request: { readonly sessionId: string },
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

export function createPragma(options: CreatePragmaOptions = {}): PragmaApp {
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
  const runtimes = options.runtimes ?? resolveDefaultRuntimeRegistry();
  const experts = new ExpertSessionManager({ sessions, executions, runtimes });
  const flows = new FlowExecutionManager(executions, runtimes);
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

function resolveDefaultRuntimeRegistry(): RuntimeRegistry {
  const configured = createDefaultRuntimeRegistryIfConfigured();
  const registry = configured ?? createDefaultRuntimeRegistry();
  if ("list" in registry && "get" in registry) return registry as RuntimeRegistry;
  return {
    get defaultRuntime() {
      return registry.defaultRuntime ?? "default";
    },
    list: () => [],
    get: (runtimeId) => {
      try {
        return registry.resolve(runtimeId);
      } catch {
        return undefined;
      }
    },
    resolve: (runtimeId) => registry.resolve(runtimeId),
  };
}
