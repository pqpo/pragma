import type { RuntimeEventEmitter } from "@expertmesh/agent-core";

export interface CloudPiRuntimeAdapterOptions {
  readonly outputParser?: <TOutput>(text: string) => TOutput;
  readonly outputRetryLimit?: number | undefined;
}

export interface PiRuntimeStreamState {
  runId?: string | undefined;
  emitter?: RuntimeEventEmitter | undefined;
}

export const defaultOutputParser = <TOutput>(text: string): TOutput => text as TOutput;
