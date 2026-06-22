import type { RuntimeStreamEventSink } from "@expertmesh/agent-core";

export interface CloudPiRuntimeAdapterOptions {
  readonly outputParser?: <TOutput>(text: string) => TOutput;
  readonly outputRetryLimit?: number | undefined;
}

export interface RuntimeStreamBridge {
  readonly nextSequence: () => number;
  runId?: string | undefined;
  onEvent?: RuntimeStreamEventSink | undefined;
}

export const defaultOutputParser = <TOutput>(text: string): TOutput => text as TOutput;
