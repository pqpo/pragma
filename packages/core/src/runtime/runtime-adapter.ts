import type {
  ExpertAgent,
  IExpertAgentModelProviderConfig,
  IExpertAgentRunResult,
} from "../agent/expert-agent.ts";
import type { AgentMessage, RuntimeSessionRef as SharedRuntimeSessionRef } from "@pragma/shared";
import type { z } from "zod";
import type { ExpertAgentLoggerProvider } from "../logging/logger.ts";
import type { RunState, SessionState } from "./agent-lifecycle.ts";
import type { ExpertAgentRunContext } from "./run-context.ts";
import type { RuntimeStreamEvent } from "./stream-events.ts";
import type { ExpertAgentHumanInteractionHandler } from "../tools/managed-tool.ts";
import type { DirectiveExecutionContext } from "../directive/types.ts";

export type RuntimeAdapterKind = "cloud-pi-agent" | (string & {});

export type RuntimeExecutionLocation = "cloud" | "local" | "self_hosted" | (string & {});

export interface RuntimeAdapterCapabilities {
  readonly targets?: readonly RuntimeTarget[] | undefined;
  readonly executionLocations?: readonly RuntimeExecutionLocation[] | undefined;
  readonly supportsStreaming?: boolean | undefined;
  readonly supportsAbort?: boolean | undefined;
  readonly supportsMcp?: boolean | undefined;
}

export type RuntimeTarget = "agent" | "code" | "directive" | "operator" | (string & {});

export interface RuntimeAdapterDescriptor {
  readonly id: string;
  readonly kind: RuntimeAdapterKind;
  readonly displayName: string;
  readonly capabilities?: RuntimeAdapterCapabilities | undefined;
}

export type RuntimeOutputSchema<TOutput = unknown> = z.ZodType<TOutput>;

export type RuntimeSessionRef = SharedRuntimeSessionRef;

export interface RuntimeSessionInfo {
  readonly systemSessionId: string;
  readonly runtimeSession: RuntimeSessionRef;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly sessionState: SessionState;
  readonly runState: RunState | undefined;
}

export interface RuntimeSessionStorageContext {
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly runtimeSession: RuntimeSessionRef;
  readonly workspace: string;
  readonly sessionDir: string;
  readonly systemSessionId?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export type RuntimeSessionSyncCallback = (
  context: RuntimeSessionStorageContext,
) => void | Promise<void>;

export type RuntimeSessionRestoreHandler = (
  context: RuntimeSessionStorageContext,
) => void | Promise<void>;

export interface RuntimeCreateSessionRequest {
  readonly agent: ExpertAgent;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly workflowExecution?: DirectiveExecutionContext | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly models?: readonly IExpertAgentModelProviderConfig[] | undefined;
  readonly systemSessionId?: string | undefined;
  readonly runtimeSession?: RuntimeSessionRef | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
}

export interface RuntimeSubmitRequest<TOutput = string> {
  readonly runId?: string | undefined;
  readonly modelName?: string | undefined;
  readonly query: string;
  readonly output?: RuntimeOutputSchema<TOutput> | undefined;
  readonly outputRetryLimit?: number | undefined;
}

export interface RuntimeRunResult<TOutput = unknown> {
  readonly runId: string;
  readonly result: IExpertAgentRunResult<TOutput>;
}

export interface RuntimeSubmitHandle<TOutput = unknown> {
  readonly runId: string;
  readonly events: AsyncIterable<RuntimeStreamEvent>;
  readonly result: Promise<RuntimeRunResult<TOutput>>;
  readonly cancel: () => Promise<void>;
}

export interface RuntimeAgentSession {
  readonly info: () => RuntimeSessionInfo;
  readonly messages: () => readonly AgentMessage[];
  readonly submit: <TSubmitOutput = string>(
    submission: RuntimeSubmitRequest<TSubmitOutput>,
  ) => RuntimeSubmitHandle<TSubmitOutput>;
  readonly abort: () => Promise<void>;
}

export interface RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly createSession: (request: RuntimeCreateSessionRequest) => Promise<RuntimeAgentSession>;
  readonly setSessionSyncCallback?: (callback: RuntimeSessionSyncCallback | undefined) => void;
  readonly setSessionRestoreHandler?: (handler: RuntimeSessionRestoreHandler | undefined) => void;
}
