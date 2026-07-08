import type {
  ExpertAgentLogger,
  ExpertAgentLoggerProvider,
  RuntimeAdapterDescriptor,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
  RuntimeEventEmitter,
  RuntimeStreamEvent,
} from "@pragma/core";

export interface CloudPiRuntimeAdapterOptions {
  readonly descriptor?: Partial<RuntimeAdapterDescriptor> | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly outputParser?: <TOutput>(text: string) => TOutput;
  readonly outputRetryLimit?: number | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
  readonly sessionSyncDebounceMs?: number | undefined;
}

export interface PiRuntimeStreamState {
  runId?: string | undefined;
  emitter?: RuntimeEventEmitter | undefined;
  source?: RuntimeStreamEvent["source"] | undefined;
  logger?: ExpertAgentLogger | undefined;
}

export const defaultOutputParser = <TOutput>(text: string): TOutput => text as TOutput;
