import { describe, expect, it } from "vitest";
import type { ModelProviderDefinition } from "@pragma/core";

import {
  createPiModelProviderConverter,
  createPiModelRegistry,
  normalizePiRuntimeModels,
  resolvePiThinkingLevel,
  resolveRequiredRuntimeModel,
} from "../src/models.ts";

describe("PI runtime model resolution", () => {
  it("uses provider and model as the canonical identity", async () => {
    const provider = {
      id: "configured-provider",
      catalogId: "custom-openai",
      models: [testModel("vendor/model-id")],
      baseUrl: "https://models.example.com/v1",
      apiKey: "configured-api-key",
      api: "openai-completions" as const,
    };
    const registry = await createPiModelRegistry([provider]);
    const model = resolveRequiredRuntimeModel(
      { providerId: provider.id, modelId: provider.models[0]!.id },
      registry,
      "agent default",
    );
    expect(model).toMatchObject({ provider: "configured-provider", id: "vendor/model-id" });
    expect(await registry.getApiKeyForProvider(model!.provider)).toBe("configured-api-key");
    expect(() =>
      resolveRequiredRuntimeModel(
        { providerId: "other", modelId: "vendor/model-id" },
        registry,
        "agent default",
      ),
    ).toThrow("Unknown agent default model: other/vendor/model-id");
  });

  it("intersects declared thinking levels with PI capabilities", () => {
    expect(
      normalizePiRuntimeModels([
        {
          id: "model",
          displayName: "Model",
          provider: { kind: "registered", id: "provider", displayName: "Provider" },
          thinking: {
            supportedLevels: [
              { value: "high", label: "High" },
              { value: "extreme", label: "Extreme" },
            ],
            defaultLevel: "extreme",
          },
        },
      ])[0]?.thinking,
    ).toEqual({ supportedLevels: [{ value: "high", label: "High" }] });
  });

  it("validates thinking levels before passing them to PI", () => {
    expect(resolvePiThinkingLevel("xhigh")).toBe("xhigh");
    expect(() => resolvePiThinkingLevel("extreme")).toThrow(
      "Unsupported PI thinking level: extreme",
    );
  });

  it("converts neutral providers inside the PI adapter boundary", () => {
    const converter = createPiModelProviderConverter();
    const provider: ModelProviderDefinition = {
      id: "provider",
      catalogId: "custom-openai",
      displayName: "Provider",
      api: "openai-completions",
      baseUrl: "https://models.example.com/v1",
      compatibilityProfileId: "pi.openai-modern@v1",
      models: [
        {
          ...testModel("reasoning-model"),
          name: "Reasoning Model",
          reasoning: true,
          thinking: {
            supportedLevels: ["off", "high"],
            defaultLevel: "high",
          },
        },
      ],
    };

    expect(converter.toRuntimeModels(provider)).toEqual([
      expect.objectContaining({
        id: "reasoning-model",
        provider: { kind: "registered", id: "provider", displayName: "Provider" },
        thinking: {
          supportedLevels: [
            { value: "off", label: "Off" },
            { value: "high", label: "High" },
          ],
          defaultLevel: "high",
        },
      }),
    ]);
    expect(
      converter.convertProvider({
        ...provider,
        apiKey: "secret",
        credentialFingerprint: "fingerprint",
      }),
    ).toMatchObject({
      id: "provider",
      api: "openai-completions",
      apiKey: "secret",
      models: [
        expect.objectContaining({
          id: "reasoning-model",
          thinking: { supportedLevels: ["off", "high"], defaultLevel: "high" },
        }),
      ],
    });
  });

  it("filters neutral protocols unsupported by PI", () => {
    const converter = createPiModelProviderConverter();
    const provider: ModelProviderDefinition = {
      id: "provider",
      catalogId: "unknown-provider",
      displayName: "Provider",
      api: "future-runtime-api",
      baseUrl: "https://models.example.com",
      models: [testModel("future-model")],
    };

    expect(converter.supports(provider.api)).toBe(false);
    expect(converter.toRuntimeModels(provider)).toEqual([]);
    expect(() =>
      converter.convertProvider({
        ...provider,
        apiKey: "secret",
        credentialFingerprint: "fingerprint",
      }),
    ).toThrow("does not support any configured models");
  });
});

function testModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}
