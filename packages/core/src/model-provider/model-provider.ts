import type { ModelApi, ProviderModelDefinition } from "@pragma/shared";

import type { RuntimeModel } from "../runtime/runtime-adapter.ts";

export interface ModelProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly api: ModelApi;
  readonly baseUrl: string;
  readonly models: readonly ProviderModelDefinition[];
}

export interface ResolvedModelProvider extends ModelProviderDefinition {
  readonly apiKey: string;
  readonly credentialFingerprint: string;
}

export interface ModelProviderRegistry {
  listProviders(): Promise<readonly ModelProviderDefinition[]>;
  resolveProvider(providerId: string): Promise<ResolvedModelProvider>;
}

export interface RuntimeModelProviderConverter<TNativeProvider> {
  supports(api: ModelApi): boolean;
  toRuntimeModels(provider: ModelProviderDefinition): readonly RuntimeModel[];
  convertProvider(provider: ResolvedModelProvider): TNativeProvider;
}

export interface ModelProviderDiscoveryRequest {
  readonly catalogId: string;
  readonly api: ModelApi;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly supportsDiscovery: boolean;
}

export interface ModelProviderDiscoveryResult {
  readonly ok: boolean;
  readonly models: readonly ProviderModelDefinition[];
  readonly source: "provider" | "catalog" | "manual";
  readonly message: string;
}

export type ModelProviderProbeCode =
  | "success"
  | "authentication"
  | "model_unavailable"
  | "timeout"
  | "network"
  | "invalid_response"
  | "unsupported_protocol"
  | "request_failed";

export interface ModelProviderProbeResult {
  readonly ok: boolean;
  readonly code: ModelProviderProbeCode;
  readonly message: string;
  readonly latencyMs?: number | undefined;
  readonly status?: number | undefined;
}

export interface ModelProviderDriver {
  readonly api: ModelApi;
  discover(options: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly signal: AbortSignal;
  }): Promise<readonly string[]>;
  probe(options: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: ProviderModelDefinition;
    readonly signal: AbortSignal;
  }): Promise<ModelProviderProbeResult>;
}

export interface ModelProviderDriverRegistry {
  get(api: ModelApi): ModelProviderDriver | undefined;
}

export interface ModelProviderDirectory {
  listModels(catalogId: string): readonly ProviderModelDefinition[];
}
