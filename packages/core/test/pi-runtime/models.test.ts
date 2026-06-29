import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPiModelRegistry } from "../../src/pi-runtime/models.ts";

describe("createPiModelRegistry", () => {
  it("registers ExpertMesh provider config in memory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "expertmesh-pi-models-"));

    const registry = createPiModelRegistry(AuthStorage.inMemory(), [
      {
        provider: "expertmesh-openai",
        modelNames: ["gpt-4o", "gpt-4.1", "gpt-4o"],
        baseApi: "https://api.openai.com/v1",
        key: "$OPENAI_API_KEY",
      },
    ]);

    const model = registry.find("expertmesh-openai", "gpt-4o");

    expect(model).toMatchObject({
      id: "gpt-4o",
      name: "gpt-4o",
      api: "openai-completions",
      provider: "expertmesh-openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
    expect(registry.find("expertmesh-openai", "gpt-4.1")).toBeDefined();
    expect(await readdir(cwd)).toEqual([]);
  });

  it("keeps literal API keys inside the registry request config", async () => {
    const registry = createPiModelRegistry(AuthStorage.inMemory(), [
      {
        provider: "expertmesh-provider",
        modelNames: ["model-1"],
        baseApi: "https://provider.example/v1",
        key: "secret-key",
        api: "openai-responses",
      },
    ]);
    const model = registry.find("expertmesh-provider", "model-1");

    expect(model).toBeDefined();
    if (model === undefined) {
      throw new Error("Expected registered model");
    }

    await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      ok: true,
      apiKey: "secret-key",
    });
  });
});
