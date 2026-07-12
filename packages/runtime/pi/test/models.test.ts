import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPiModelRegistry, resolveRuntimeModel } from "../src/models.ts";

describe("createPiModelRegistry", () => {
  it("registers Pragma provider config in memory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pragma-pi-models-"));

    const registry = createPiModelRegistry(AuthStorage.inMemory(), [
      {
        provider: "pragma-openai",
        modelNames: ["gpt-4o", "gpt-4.1", "gpt-4o"],
        baseApi: "https://api.openai.com/v1",
        key: "$OPENAI_API_KEY",
      },
    ]);

    const model = registry.find("pragma-openai", "gpt-4o");

    expect(model).toMatchObject({
      id: "gpt-4o",
      name: "gpt-4o",
      api: "openai-completions",
      provider: "pragma-openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
    expect(registry.find("pragma-openai", "gpt-4.1")).toBeDefined();
    expect(await readdir(cwd)).toEqual([]);
  });

  it("keeps literal API keys inside the registry request config", async () => {
    const registry = createPiModelRegistry(AuthStorage.inMemory(), [
      {
        provider: "pragma-provider",
        modelNames: ["model-1"],
        baseApi: "https://provider.example/v1",
        key: "secret-key",
        api: "openai-responses",
      },
    ]);
    const model = registry.find("pragma-provider", "model-1");

    expect(model).toBeDefined();
    if (model === undefined) {
      throw new Error("Expected registered model");
    }

    await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      ok: true,
      apiKey: "secret-key",
    });
  });

  it("prefers an exact provider/model match over a bare model id", () => {
    const registry = createPiModelRegistry(AuthStorage.inMemory(), [
      {
        provider: "deepseek",
        modelNames: ["deepseek-v4-flash"],
        baseApi: "https://api.deepseek.com",
        key: "secret-key",
        api: "openai-completions",
      },
    ]);

    expect(resolveRuntimeModel("deepseek/deepseek-v4-flash", registry)).toMatchObject({
      provider: "deepseek",
      id: "deepseek-v4-flash",
    });
    expect(resolveRuntimeModel("openrouter/deepseek/deepseek-v4-flash", registry)).toMatchObject({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash",
    });
  });
});
