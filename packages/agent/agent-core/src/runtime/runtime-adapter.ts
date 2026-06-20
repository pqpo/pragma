import type {
  ExpertAgent,
  IExpertAgentRunResult,
} from "../agent/expert-agent.ts";
import type { z } from "zod";
import type { AgentLifecycleState } from "./agent-lifecycle.ts";
import type { ExpertAgentRunContext } from "./run-context.ts";
import type { RuntimeStreamOptions } from "./stream-events.ts";

export type RuntimeAdapterKind = "cloud-pi-agent";

export interface RuntimeAdapterDescriptor {
  readonly id: string;
  readonly kind: RuntimeAdapterKind;
  readonly displayName: string;
}

export type RuntimeOutputSchema<TOutput = unknown> = z.ZodType<TOutput>;

export interface RuntimeSessionInfo {
  readonly sessionId: string;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly state: AgentLifecycleState;
}

export interface RuntimeCreateSessionRequest {
  readonly agent: ExpertAgent;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface RuntimeSubmitRequest<TOutput = string> extends RuntimeStreamOptions {
  readonly runId?: string | undefined;
  readonly query: string;
  readonly output?: RuntimeOutputSchema<TOutput> | undefined;
}

export interface RuntimeRunResult<TOutput = unknown> {
  readonly runId: string;
  readonly result: IExpertAgentRunResult<TOutput>;
}

export interface RuntimeAgentSession<TOutput = unknown> {
  readonly info: () => RuntimeSessionInfo;
  readonly state: () => AgentLifecycleState;
  readonly submit: <TSubmitOutput = TOutput>(
    submission: RuntimeSubmitRequest<TSubmitOutput>,
  ) => Promise<RuntimeRunResult<TSubmitOutput>>;
  readonly abort: () => Promise<void>;
}

export interface RuntimeAdapter<TOutput = unknown> {
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly createSession: (
    request: RuntimeCreateSessionRequest,
  ) => Promise<RuntimeAgentSession<TOutput>>;
}
