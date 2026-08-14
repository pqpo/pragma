import type {
  PragmaLogger,
  RuntimeDriverDescriptorOverride,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
  RuntimeEventEmitter,
  RuntimeStreamEvent,
  McpToolRegistryPool,
  ModelProviderRegistry,
  RuntimeTokenCounter,
} from "@pragma/core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelThinkingCapability } from "@pragma/shared";

export interface PiProviderModelConfig {
  readonly id: string;
  readonly name: string;
  readonly api?: Api | undefined;
  readonly baseUrl?: string | undefined;
  readonly reasoning: boolean;
  readonly thinking?: ModelThinkingCapability | undefined;
  readonly compatibilityProfileId?: string | undefined;
  readonly thinkingLevelMap?: Model<Api>["thinkingLevelMap"] | undefined;
  readonly input: readonly ("text" | "image")[];
  readonly cost: Model<Api>["cost"];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly compat?: Model<Api>["compat"] | undefined;
}

export interface PiModelProviderConfig {
  readonly id: string;
  readonly catalogId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly PiProviderModelConfig[];
  readonly api: Api;
  readonly compatibilityProfileId?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly authHeader?: boolean | undefined;
}

export interface CloudPiRuntimeAdapterOptions {
  readonly descriptor?: RuntimeDriverDescriptorOverride | undefined;
  /** The host-provided, filtered environment for Pragma-owned local tools. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly modelProviders?: ModelProviderRegistry | undefined;
  readonly outputParser?: <TOutput>(text: string) => TOutput;
  readonly outputRetryLimit?: number | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
  readonly sessionSyncDebounceMs?: number | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
}

export interface PiRuntimeStreamState {
  runId?: string | undefined;
  emitter?: RuntimeEventEmitter | undefined;
  source?: RuntimeStreamEvent["source"] | undefined;
  logger?: PragmaLogger | undefined;
}

export const defaultOutputParser = <TOutput>(text: string): TOutput => text as TOutput;
