import {
  createBuiltInModelProviderDriverRegistry,
  createUnknownProviderModel,
  discoverModelProviderModels,
} from "@pragma/core";

import type {
  ModelDiscoveryResult,
  ModelProvider,
  ModelProviderModel,
} from "../../deployment-contracts/index.ts";
import { findModelProviderPreset } from "../../deployment-contracts/index.ts";
import { normalizeModelProviderBaseUrl } from "./model-provider-store.ts";

export function createModelDiscovery(generationDirectory: {
  listModels(
    catalogId: string,
  ): ReturnType<Parameters<typeof discoverModelProviderModels>[0]["directory"]["listModels"]>;
}) {
  const embeddingModels = [
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-embedding-ada-002",
  ].map((id) => ({
    kind: "embedding" as const,
    id,
    name: id,
    api: "openai-embeddings" as const,
    maxInputTokens: 8192,
    maxInputTokensSource: "catalog" as const,
    maxBatchInputs: 32,
    maxBatchTokens: 300000,
    cost: { input: 0 },
  }));
  const directory = {
    listModels: (catalogId: string) => [
      ...generationDirectory.listModels(catalogId),
      ...(catalogId === "openai" ? embeddingModels : []),
    ],
  };
  const drivers = createBuiltInModelProviderDriverRegistry();

  async function discoverProviderModels(options: {
    readonly presetId: string;
    readonly protocol: ModelProvider["protocol"];
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly fetchImpl?: typeof fetch;
  }): Promise<ModelDiscoveryResult> {
    const preset = findModelProviderPreset(options.presetId);
    const capabilityCatalogId = preset?.capabilityCatalogId ?? options.presetId;
    const baseUrl = normalizeModelProviderBaseUrl(options.baseUrl);
    const activeDrivers =
      options.fetchImpl === undefined
        ? drivers
        : createBuiltInModelProviderDriverRegistry({ fetch: options.fetchImpl });
    const result = await discoverModelProviderModels({
      request: {
        catalogId: capabilityCatalogId,
        api: options.protocol,
        baseUrl,
        apiKey: options.apiKey,
        supportsDiscovery: preset?.supportsDiscovery ?? true,
      },
      drivers: activeDrivers,
      directory,
    });
    const suggestedIds = new Set(
      directory.listModels(capabilityCatalogId).map((model) => model.id),
    );
    return {
      ...result,
      source: result.source === "catalog" ? "preset" : result.source,
      models: result.models.map((model): ModelProviderModel => ({
        ...model,
        capabilitiesSource:
          result.source === "catalog"
            ? "preset"
            : suggestedIds.has(model.id)
              ? "provider"
              : "manual",
      })),
    };
  }

  function unknownModel(id: string, protocol: ModelProvider["protocol"]): ModelProviderModel {
    return { ...createUnknownProviderModel(id, protocol), capabilitiesSource: "manual" };
  }

  return { discoverProviderModels, unknownModel };
}
