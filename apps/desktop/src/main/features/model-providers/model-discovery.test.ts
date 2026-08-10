import { describe, expect, it, vi } from "vitest";

import { discoverProviderModels } from "./model-discovery.ts";

describe("model discovery", () => {
  it("loads OpenAI-compatible model IDs and treats unknown capabilities conservatively", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "vendor/reasoning-model" }] }), { status: 200 }),
      );

    const result = await discoverProviderModels({
      presetId: "custom-openai",
      protocol: "openai-completions",
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret",
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      source: "provider",
      models: [
        expect.objectContaining({
          id: "vendor/reasoning-model",
          reasoning: false,
          input: ["text"],
          capabilitiesSource: "manual",
        }),
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://models.example.com/v1/models"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("normalizes Gemini model names and falls back without blocking manual setup", async () => {
    const success = await discoverProviderModels({
      presetId: "google",
      protocol: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-key",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ models: [{ name: "models/gemini-test" }] })),
        ),
    });
    const failure = await discoverProviderModels({
      presetId: "custom-openai",
      protocol: "openai-completions",
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret",
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });

    expect(success.models[0]?.id).toBe("gemini-test");
    expect(failure).toMatchObject({ ok: false, source: "manual", models: [] });
  });

  it("uses the Qwen capability catalog for Bailian model IDs", async () => {
    const result = await discoverProviderModels({
      presetId: "qwen",
      protocol: "openai-completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "secret",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: "qwen3.7-plus" }] }), { status: 200 }),
        ),
    });

    expect(result.models).toEqual([
      expect.objectContaining({
        id: "qwen3.7-plus",
        input: ["text", "image"],
        capabilitiesSource: "provider",
      }),
    ]);
  });

  it("rejects non-loopback HTTP endpoints before sending credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      discoverProviderModels({
        presetId: "custom-openai",
        protocol: "openai-completions",
        baseUrl: "http://models.example.com/v1",
        apiKey: "secret",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid_base_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
