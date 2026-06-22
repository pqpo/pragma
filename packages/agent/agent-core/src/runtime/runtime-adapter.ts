import type {
  ExpertAgent,
  IExpertAgentModelProviderConfig,
  IExpertAgentRunResult,
} from "../agent/expert-agent.ts";
import type { z } from "zod";
import type { RunState, SessionState } from "./agent-lifecycle.ts";
import type { ExpertAgentRunContext } from "./run-context.ts";
import type { RuntimeStreamOptions } from "./stream-events.ts";

export type RuntimeAdapterKind = "cloud-pi-agent" | (string & {});

export type RuntimeExecutionLocation = "cloud" | "local" | "self_hosted" | (string & {});

export interface RuntimeAdapterCapabilities {
  readonly executionLocations?: readonly RuntimeExecutionLocation[] | undefined;
  readonly supportsStreaming?: boolean | undefined;
  readonly supportsAbort?: boolean | undefined;
  readonly supportsSubAgents?: boolean | undefined;
  readonly supportsMcp?: boolean | undefined;
}

export interface RuntimeAdapterDescriptor {
  readonly id: string;
  readonly kind: RuntimeAdapterKind;
  readonly displayName: string;
  readonly capabilities?: RuntimeAdapterCapabilities | undefined;
}

export type RuntimeOutputSchema<TOutput = unknown> = z.ZodType<TOutput>;

export interface RuntimeSessionRef {
  readonly type: RuntimeAdapterKind;
  readonly id: string;
}

export interface RuntimeSessionInfo {
  readonly systemSessionId: string;
  readonly runtimeSession: RuntimeSessionRef;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly sessionState: SessionState;
  readonly runState: RunState | undefined;
}

export interface RuntimeCreateSessionRequest {
  readonly agent: ExpertAgent;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly models?: readonly IExpertAgentModelProviderConfig[] | undefined;
  readonly systemSessionId?: string | undefined;
  readonly runtimeSession?: RuntimeSessionRef | undefined;
}

export interface RuntimeSubmitRequest<TOutput = string> extends RuntimeStreamOptions {
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

export interface RuntimeAgentSession {
  readonly info: () => RuntimeSessionInfo;
  readonly submit: <TSubmitOutput = string>(
    submission: RuntimeSubmitRequest<TSubmitOutput>,
  ) => Promise<RuntimeRunResult<TSubmitOutput>>;
  readonly abort: () => Promise<void>;
}

export interface RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly createSession: (request: RuntimeCreateSessionRequest) => Promise<RuntimeAgentSession>;
}
