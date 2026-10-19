import { createOpenAIEmbeddingProvider } from "@pragma/memory";
import type { ResolvedModelProvider } from "@pragma/core";

import type { ModelThinkingLevel } from "@pragma/shared";

import type {
  ModelConnectionTestResult,
  ModelProviderModel,
} from "../../deployment-contracts/index.ts";

export function createModelConnectionTester(
  probeGeneration: (options: {
    readonly provider: ResolvedModelProvider;
    readonly modelId: string;
    readonly thinkingLevel?: ModelThinkingLevel;
  }) => Promise<ModelConnectionTestResult>,
) {
  return async function testProviderModel(options: {
    readonly provider: ResolvedModelProvider;
    readonly model: ModelProviderModel;
    readonly thinkingLevel?: ModelThinkingLevel | undefined;
  }): Promise<ModelConnectionTestResult> {
    if (options.model.kind === "embedding") {
      if (options.model.maxInputTokens === undefined)
        return {
          ok: false,
          code: "request_failed",
          message: "Confirm the embedding input-token limit before testing.",
        };
      const started = Date.now(),
        model = options.model;
      const provider = createOpenAIEmbeddingProvider({
        profile: {
          fingerprint: "connection-check",
          providerId: options.provider.id,
          modelId: model.id,
          baseUrl: model.baseUrl ?? options.provider.baseUrl,
          maxInputTokens: model.maxInputTokens!,
          maxBatchInputs: model.maxBatchInputs,
          maxBatchTokens: model.maxBatchTokens ?? model.maxInputTokens!,
          projectionVersion: 1,
        },
        getApiKey: async () => options.provider.apiKey,
      });
      try {
        const result = await provider.validate(AbortSignal.timeout(10_000));
        return {
          ok: true,
          code: "success",
          message: `Embedding ready (${result.dimensions} dimensions).`,
          latencyMs: Date.now() - started,
        };
      } catch {
        return {
          ok: false,
          code: "request_failed",
          message: "The embedding connection check failed.",
        };
      }
    }
    return await probeGeneration({
      provider: options.provider,
      modelId: options.model.id,
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    });
  };
}
