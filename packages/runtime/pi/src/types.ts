import type {
  ExpertAgentLogger,
  ExpertAgentLoggerProvider,
  RuntimeAdapterDescriptor,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
  RuntimeEventEmitter,
  RuntimeStreamEvent,
  RuntimeModel,
} from "@pragma/core";

export interface PiModelProviderConfig {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelIds: readonly string[];
  readonly api: string;
}

export interface PiModelCatalog {
  readonly listModels: () => Promise<readonly RuntimeModel[]>;
  readonly resolveProvider: (providerId: string) => Promise<PiModelProviderConfig>;
}

export interface CloudPiRuntimeAdapterOptions {
  readonly descriptor?: Partial<RuntimeAdapterDescriptor> | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly modelCatalog?: PiModelCatalog | undefined;
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
