import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  createPiModelRegistry,
  normalizePiRuntimeModels,
  resolvePiThinkingLevel,
  resolveRequiredRuntimeModel,
} from "../src/models.ts";

describe("PI runtime model resolution", () => {
  it("uses provider and model as the canonical identity", async () => {
    const provider = {
      id: "configured-provider",
      modelIds: ["vendor/model-id"],
      baseUrl: "https://models.example.com/v1",
      apiKey: "configured-api-key",
      api: "openai-completions",
    };
    const registry = createPiModelRegistry(AuthStorage.create(), [provider]);
    const model = resolveRequiredRuntimeModel(
      { providerId: provider.id, modelId: provider.modelIds[0]! },
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
});
