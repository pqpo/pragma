import { describe, expect, it, vi } from "vitest";

import { testOpenAiCompatibleModel } from "./model-connectivity.ts";

describe("testOpenAiCompatibleModel", () => {
  it("sends a minimal OpenAI chat completion request and reports success", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }),
    );

    const result = await testOpenAiCompatibleModel({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-4.1-mini",
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, code: "success" });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://api.example.com/v1/chat/completions"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
      }),
    );
  });

  it("maps authentication, unavailable model, and malformed success responses to safe results", async () => {
    const authentication = await testOpenAiCompatibleModel({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-4.1",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    });
    const missingModel = await testOpenAiCompatibleModel({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-missing",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
    });
    const malformed = await testOpenAiCompatibleModel({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-4.1",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 })),
    });

    expect(authentication).toMatchObject({ ok: false, code: "authentication", status: 401 });
    expect(missingModel).toMatchObject({ ok: false, code: "model_unavailable", status: 404 });
    expect(malformed).toMatchObject({ ok: false, code: "invalid_response" });
  });
});
