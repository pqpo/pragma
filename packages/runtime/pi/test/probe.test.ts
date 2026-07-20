import type { ResolvedModelProvider } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { probePiModelProvider } from "../src/probe.ts";

describe("probePiModelProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the conservative system role for an unknown OpenAI-compatible reasoning model", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(streamResponse());
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      probePiModelProvider({ provider: testProvider(), modelId: "reasoning-test" }),
    ).resolves.toMatchObject({ ok: true, code: "success" });

    const body = requestBody(fetchImpl);
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user" }),
    ]);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("uses the explicitly selected modern OpenAI compatibility profile", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(streamResponse());
    vi.stubGlobal("fetch", fetchImpl);

    await probePiModelProvider({
      provider: {
        ...testProvider(),
        compatibilityProfileId: "pi.openai-modern@v1",
      },
      modelId: "reasoning-test",
      thinkingLevel: "high",
    });

    const body = requestBody(fetchImpl);
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "developer" }),
      expect.objectContaining({ role: "user" }),
    ]);
    expect(body).toHaveProperty("reasoning_effort", "high");
  });

  it("classifies provider authentication errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      probePiModelProvider({ provider: testProvider(), modelId: "reasoning-test" }),
    ).resolves.toMatchObject({ ok: false, code: "authentication", status: 401 });
  });
});

function testProvider(): ResolvedModelProvider {
  return {
    id: "provider-id",
    catalogId: "custom-openai",
    displayName: "Provider",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    credentialFingerprint: "fingerprint",
    models: [
      {
        id: "reasoning-test",
        name: "Reasoning Test",
        reasoning: true,
        thinking: { supportedLevels: ["off", "high"], defaultLevel: "high" },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  };
}

function streamResponse(): Response {
  const chunks = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "reasoning-test",
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "reasoning-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

function requestBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> & {
  readonly messages: unknown;
} {
  const init = fetchImpl.mock.calls[0]?.[1];
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(init.body) as Record<string, unknown> & { readonly messages: unknown };
}
