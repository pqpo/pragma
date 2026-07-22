import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelProviderDirectory } from "@pragma/core";
import type { ProviderModelDefinition } from "@pragma/shared";

const BUILTIN_PROVIDERS = new Set<string>(getBuiltinProviders());

export function createPiModelProviderDirectory(): ModelProviderDirectory {
  return {
    listModels(catalogId) {
      return listPiBuiltinModels(catalogId).map(toProviderModelDefinition);
    },
  };
}

export function findPiBuiltinModel(catalogId: string, modelId: string): Model<Api> | undefined {
  return listPiBuiltinModels(catalogId).find((model) => model.id === modelId);
}

function listPiBuiltinModels(catalogId: string): readonly Model<Api>[] {
  if (!BUILTIN_PROVIDERS.has(catalogId)) return [];
  return getBuiltinModels(catalogId as BuiltinProvider) as readonly Model<Api>[];
}

function toProviderModelDefinition(model: Model<Api>): ProviderModelDefinition {
  const supportedLevels = getSupportedThinkingLevels(model);
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    ...(model.reasoning && supportedLevels.length > 0 ? { thinking: { supportedLevels } } : {}),
    input: [...model.input],
    cost: {
      ...model.cost,
      ...(model.cost.tiers === undefined
        ? {}
        : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }),
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
