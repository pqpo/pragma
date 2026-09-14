import { describe, expect, it } from "vitest";
import type { ModelProviderDefinition } from "@pragma/core";

import {
  createPiModelProviderConverter,
  createPiModelRegistry,
  createPiModelRuntime,
  normalizePiRuntimeModels,
  registerPiModelProvider,
  resolvePiThinkingLevel,
  resolveRequiredRuntimeModel,
} from "../src/models.ts";
import { createPiModelProviderDirectory } from "../src/catalog.ts";
import {
  DEFAULT_PI_AGENT_CONTEXT_WINDOW_TOKENS,
  resolvePiEffectiveContextWindow,
} from "../src/context-window.ts";

describe("PI runtime model resolution", () => {
  it("exposes the one-million-token Qwen Max catalog limits", () => {
    const models = createPiModelProviderDirectory().listModels("qwen-token-plan-cn");

    expect(models.filter((model) => ["qwen3.7-max", "qwen3.8-max"].includes(model.id))).toEqual([
      expect.objectContaining({
        id: "qwen3.7-max",
        contextWindow: 1_000_000,
        maxTokens: 131_072,
      }),
      expect.objectContaining({
        id: "qwen3.8-max",
        contextWindow: 1_000_000,
        maxTokens: 131_072,
      }),
    ]);
  });

  it("limits Pi-native models to the Agent working context without changing model capability", () => {
    const converter = createPiModelProviderConverter({ agentContextWindow: 258_000 });
    const provider: ModelProviderDefinition = {
      id: "provider",
      catalogId: "qwen-token-plan-cn",
      displayName: "Provider",
      api: "openai-completions",
      baseUrl: "https://models.example.com/v1",
      models: [{ ...testModel("qwen3.8-max"), contextWindow: 1_000_000 }],
    };

    const native = converter.convertProvider({
      ...provider,
      apiKey: "secret",
      credentialFingerprint: "fingerprint",
    });

    expect(provider.models[0]?.contextWindow).toBe(1_000_000);
    expect(native.models[0]?.contextWindow).toBe(258_000);
  });

  it("resolves an Agent window as the lower of configured and model limits", () => {
    expect(DEFAULT_PI_AGENT_CONTEXT_WINDOW_TOKENS).toBe(258_000);
    expect(
      [128_000, 200_000, 258_000, 512_000, 1_000_000].map((modelContextWindow) =>
        resolvePiEffectiveContextWindow({ agentContextWindow: 258_000, modelContextWindow }),
      ),
    ).toEqual([128_000, 200_000, 258_000, 258_000, 258_000]);
    expect(() =>
      resolvePiEffectiveContextWindow({ agentContextWindow: 0, modelContextWindow: 128_000 }),
    ).toThrow("Agent context window must be a positive safe integer.");
  });

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

  it("rebinds a provider inside one native model runtime", async () => {
    const original = {
      id: "configured-provider",
      catalogId: "custom-openai",
      models: [testModel("model-a")],
      baseUrl: "https://models.example.com/v1",
      apiKey: "key-a",
      api: "openai-completions" as const,
    };
    const { modelRegistry, modelRuntime } = await createPiModelRuntime([original]);
    registerPiModelProvider(modelRuntime, {
      ...original,
      models: [testModel("model-b")],
      apiKey: "key-b",
    });

    expect(modelRegistry.getAll().filter((model) => model.provider === original.id)).toEqual([
      expect.objectContaining({ provider: original.id, id: "model-b" }),
    ]);
    expect(await modelRegistry.getApiKeyForProvider(original.id)).toBe("key-b");
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
    expect(() => resolvePiThinkingLevel("extreme")).toThrow("Unsupported thinking level: extreme");
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
    ).toThrow("No configured models are supported");
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
