import { describe, expect, it } from "vitest";
import { createPiRuntime } from "../src/index.ts";

describe("PI Runtime contract", () => {
  it("declares split Session lifecycle capabilities with safe steer", () => {
    const runtime = createPiRuntime();
    expect(runtime.descriptor.capabilities).toMatchObject({
      supportsResume: true,
      supportsCancel: true,
      supportsClose: true,
      supportsSteer: true,
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
        thinking: {
          supportedLevels: [{ value: "high", label: "High" }],
          defaultLevel: "high",
        },
      },
    ];
    const runtime = createPiRuntime({
      modelCatalog: {
        listModels: async () => models,
        resolveProvider: async () => ({
          id: "provider-id",
          modelIds: ["gpt-test"],
          baseUrl: "https://models.example.com/v1",
          apiKey: "secret",
          api: "openai-completions",
        }),
      },
    });

    await expect(runtime.listModels?.()).resolves.toEqual(models);
  });
});
