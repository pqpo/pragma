import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Expert } from "@pragma/core";
import { describe, expect, it } from "vitest";

import {
  createPiModelRegistry,
  getRuntimeModelName,
  resolveRequiredRuntimeModel,
} from "../src/models.ts";

describe("PI runtime model resolution", () => {
  it("prefers the configured provider when its model ID collides with a built-in model", async () => {
    const provider = {
      provider: "configured-provider",
      modelNames: ["opencode-go/minimax-m2.7"],
      baseApi: "https://models.example.com/v1",
      key: "configured-api-key",
      api: "openai-completions" as const,
    };
    const agent = {
      models: {
        defaultModelName: provider.modelNames[0],
        providers: [provider],
      },
    } as unknown as Expert;
    const registry = createPiModelRegistry(AuthStorage.create(), [provider]);

    const modelName = getRuntimeModelName(agent, undefined);
    const model = resolveRequiredRuntimeModel(modelName, registry, "agent default");

    expect(modelName).toBe("configured-provider/opencode-go/minimax-m2.7");
    expect(model).toMatchObject({
      provider: "configured-provider",
      id: "opencode-go/minimax-m2.7",
    });
    expect(await registry.getApiKeyForProvider(model!.provider)).toBe("configured-api-key");
  });

  it("keeps built-in model references unchanged without a matching configured provider", () => {
    const agent = {
      models: {
        defaultModelName: "opencode-go/minimax-m2.7",
        providers: [],
      },
    } as unknown as Expert;

    expect(getRuntimeModelName(agent, undefined)).toBe("opencode-go/minimax-m2.7");
  });

  it("keeps canonical configured model references stable across resolution", () => {
    const agent = {
      models: {
        defaultModelName: "vendor/model-id",
        providers: [
          {
            provider: "configured-provider",
            modelNames: ["vendor/model-id"],
          },
          {
            provider: "nested-provider",
            modelNames: ["configured-provider/vendor/model-id"],
          },
        ],
      },
    } as unknown as Expert;

    const canonicalModelName = getRuntimeModelName(agent, undefined);

    expect(canonicalModelName).toBe("configured-provider/vendor/model-id");
    expect(getRuntimeModelName(agent, canonicalModelName)).toBe(canonicalModelName);
  });
});
