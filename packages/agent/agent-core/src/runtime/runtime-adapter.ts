import type {
  ExpertAgent,
  IExpertAgentRunRequest,
  IExpertAgentRunResult,
} from "../agent/expert-agent.ts";
import type { AgentLifecycleState } from "./agent-lifecycle.ts";
import type { RuntimeStreamOptions } from "./stream-events.ts";

export type RuntimeAdapterKind = "cloud-pi-agent";

export interface RuntimeAdapterDescriptor {
  readonly id: string;
  readonly kind: RuntimeAdapterKind;
  readonly displayName: string;
}

export interface RuntimeInvocation {
  readonly runId: string;
}

export interface RuntimePrepareRequest {
  readonly agent: ExpertAgent;
}

export interface RuntimeRunRequest<TInput = unknown> extends RuntimeStreamOptions {
  readonly invocation: RuntimeInvocation;
  readonly request: IExpertAgentRunRequest<TInput>;
}

export interface RuntimeRunResult<TOutput = unknown> {
  readonly runId: string;
  readonly result: IExpertAgentRunResult<TOutput>;
}

export interface RuntimeAgentSession<TInput = unknown, TOutput = unknown> {
  readonly state: () => AgentLifecycleState;
  readonly run: (request: RuntimeRunRequest<TInput>) => Promise<RuntimeRunResult<TOutput>>;
  readonly abort: () => Promise<void>;
}

export interface RuntimeAdapter<TInput = unknown, TOutput = unknown> {
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly prepare: (
    request: RuntimePrepareRequest,
  ) => Promise<RuntimeAgentSession<TInput, TOutput>>;
}
