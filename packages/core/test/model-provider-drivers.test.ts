import { describe, expect, it, vi } from "vitest";

import { createBuiltInModelProviderDirectory } from "../src/model-provider/model-provider-directory.ts";
import {
  createBuiltInModelProviderDriverRegistry,
  discoverModelProviderModels,
  probeModelProvider,
} from "../src/model-provider/model-provider-drivers.ts";

describe("model provider drivers", () => {
  it("discovers models and enriches known identities from the Pragma directory", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ id: "o4-mini-deep-research" }, { id: "vendor/model" }] }),
        ),
      );
    const result = await discoverModelProviderModels({
      request: {
        catalogId: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "secret",
        supportsDiscovery: true,
      },
      drivers: createBuiltInModelProviderDriverRegistry({ fetch: fetchImpl }),
      directory: createBuiltInModelProviderDirectory(),
    });

    expect(result).toMatchObject({
      ok: true,
      source: "provider",
      models: [
        expect.objectContaining({ id: "o4-mini-deep-research", reasoning: true }),
        expect.objectContaining({ id: "vendor/model", reasoning: false }),
      ],
    });
  });

  it("uses the neutral catalog when a provider has no discovery endpoint", async () => {
    const result = await discoverModelProviderModels({
      request: {
        catalogId: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "secret",
        supportsDiscovery: false,
      },
      drivers: createBuiltInModelProviderDriverRegistry(),
      directory: createBuiltInModelProviderDirectory(),
    });

    expect(result).toMatchObject({
      ok: true,
      source: "catalog",
      models: [expect.objectContaining({ id: "claude-sonnet-5" })],
    });
  });

  it("uses Anthropic's versioned models endpoint when discovery is enabled", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "claude-test" }] })));
    const result = await discoverModelProviderModels({
      request: {
        catalogId: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "secret",
        supportsDiscovery: true,
      },
      drivers: createBuiltInModelProviderDriverRegistry({ fetch: fetchImpl }),
      directory: createBuiltInModelProviderDirectory(),
    });

    expect(result).toMatchObject({ ok: true, source: "provider" });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://api.anthropic.com/v1/models"),
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "secret" }) }),
    );
  });

  it.each([
    {
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      endpoint: "https://api.example.com/v1/chat/completions",
      response: { choices: [{}] },
      header: ["Authorization", "Bearer secret"],
    },
    {
      api: "openai-responses",
      baseUrl: "https://api.example.com/v1",
      endpoint: "https://api.example.com/v1/responses",
      response: { id: "response" },
      header: ["Authorization", "Bearer secret"],
    },
    {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      endpoint: "https://api.anthropic.com/v1/messages",
      response: { content: [] },
      header: ["x-api-key", "secret"],
    },
    {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      endpoint: "https://api.anthropic.com/v1/messages",
      response: { content: [] },
      header: ["x-api-key", "secret"],
    },
    {
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent?key=secret",
      response: { candidates: [] },
      header: ["Accept", "application/json"],
    },
    {
      api: "mistral-conversations",
      baseUrl: "https://api.mistral.ai/v1",
      endpoint: "https://api.mistral.ai/v1/chat/completions",
      response: { choices: [{}] },
      header: ["Authorization", "Bearer secret"],
    },
  ] as const)("probes $api without a Runtime SDK", async (testCase) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(testCase.response)));
    const result = await probeModelProvider({
      api: testCase.api,
      baseUrl: testCase.baseUrl,
      apiKey: "secret",
      model: {
        id: "test-model",
        name: "Test Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      drivers: createBuiltInModelProviderDriverRegistry({ fetch: fetchImpl }),
    });

    expect(result).toMatchObject({ ok: true, code: "success" });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(testCase.endpoint),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ [testCase.header[0]]: testCase.header[1] }),
      }),
    );
  });

  it("rejects unknown protocols without making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await probeModelProvider({
      api: "future-runtime-api",
      baseUrl: "https://api.example.com",
      apiKey: "secret",
      model: {
        id: "model",
        name: "Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      drivers: createBuiltInModelProviderDriverRegistry({ fetch: fetchImpl }),
    });

    expect(result).toMatchObject({ ok: false, code: "unsupported_protocol" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
