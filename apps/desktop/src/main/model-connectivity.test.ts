import type { ResolvedModelProvider } from "@pragma/core";
import { probePiModelProvider } from "@pragma/runtime-pi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { testProviderModel } from "./model-connectivity.ts";

vi.mock("@pragma/runtime-pi", () => ({ probePiModelProvider: vi.fn() }));

describe("testProviderModel", () => {
  beforeEach(() => {
    vi.mocked(probePiModelProvider).mockReset();
  });

  it("tests the exact saved provider through PI", async () => {
    vi.mocked(probePiModelProvider).mockResolvedValue({
      ok: true,
      code: "success",
      message: "Connection successful through the PI runtime.",
    });
    const model = testModel("gpt-test");
    const provider: ResolvedModelProvider = {
      id: "provider-id",
      catalogId: "custom-openai",
      displayName: "Provider",
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      credentialFingerprint: "fingerprint",
      models: [model],
    };

    await expect(
      testProviderModel({
        provider,
        model: { ...model, capabilitiesSource: "manual" },
        thinkingLevel: "high",
      }),
    ).resolves.toMatchObject({ ok: true, code: "success" });
    expect(probePiModelProvider).toHaveBeenCalledWith({
      provider,
      modelId: "gpt-test",
      thinkingLevel: "high",
    });
  });
});

function testModel(id: string) {
  return {
    id,
    name: id,
    api: "openai-completions" as const,
    reasoning: true,
    thinking: {
      supportedLevels: ["off", "high"] as ("off" | "high")[],
      defaultLevel: "high" as const,
    },
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}
