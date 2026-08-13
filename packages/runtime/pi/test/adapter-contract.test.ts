import { describe, expect, it } from "vitest";
import { describeRuntimeConformance } from "@pragma/core/testing/vitest";
import { createPiRuntime } from "../src/index.ts";

describeRuntimeConformance("PI", { createRuntime: createPiRuntime });

describe("PI Runtime contract", () => {
  it("declares split Session lifecycle capabilities with safe steer", () => {
    const runtime = createPiRuntime();
    expect(runtime.descriptor.capabilities).toMatchObject({
      supportsResume: true,
      supportsCancel: true,
      supportsClose: true,
      supportsSteer: true,
      supportsContextWindowInspection: true,
      supportsManualCompaction: true,
      supportsContextCompactionEvents: true,
    });
  });

  it("publishes models supplied by the registered model catalog", async () => {
    const models = [
      {
        id: "gpt-test",
        displayName: "GPT Test",
        provider: {
          kind: "registered" as const,
          id: "provider-id",
          displayName: "Provider",
        },
        inputModalities: ["text"],
        thinking: {
          supportedLevels: [{ value: "off", label: "Off" }],
        },
      },
    ];
    const runtime = createPiRuntime({
      modelProviders: {
        listProviders: async () => [
          {
            id: "provider-id",
            catalogId: "custom-openai",
            displayName: "Provider",
            api: "openai-completions",
            baseUrl: "https://models.example.com/v1",
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                reasoning: true,
                thinking: { supportedLevels: ["off"] },
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        ],
        resolveProvider: async () => ({
          id: "provider-id",
          catalogId: "custom-openai",
          displayName: "Provider",
          models: [
            {
              id: "gpt-test",
              name: "GPT Test",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 16_384,
            },
          ],
          baseUrl: "https://models.example.com/v1",
          apiKey: "secret",
          api: "openai-completions",
          credentialFingerprint: "fingerprint",
        }),
      },
    });

    await expect(runtime.listModels?.()).resolves.toEqual(models);
  });
});
