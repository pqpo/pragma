import type {
  ExpertAgentLogger,
  ExpertAgentLoggerProvider,
  RuntimeEventEmitter,
  RuntimeStreamEvent,
} from "@expertmesh/agent-core";

export interface CloudPiRuntimeAdapterOptions {
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly outputParser?: <TOutput>(text: string) => TOutput;
  readonly outputRetryLimit?: number | undefined;
}

export interface PiRuntimeStreamState {
  runId?: string | undefined;
  emitter?: RuntimeEventEmitter | undefined;
  source?: RuntimeStreamEvent["source"] | undefined;
  logger?: ExpertAgentLogger | undefined;
}

export const defaultOutputParser = <TOutput>(text: string): TOutput => text as TOutput;
