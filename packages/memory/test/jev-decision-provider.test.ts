import { describe, expect, it, vi } from "vitest";
import { createJevDecisionProvider } from "../src/index.ts";

describe("JevDecisionProvider", () => {
  it("uses closed Choice criteria and rejects unknown actions; budgets include every request", async () => {
    const delta = {
      missionId: "m",
      contextId: "c",
      missionGoal: "goal",
      latestObservation: "error",
      lastAction: "tool",
      trigger: "new_error" as const,
      concepts: [],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "jev",
        answers: {
          continue: { type: "noul", noul: 0.95 },
          next: {
            type: "choice",
            choice: "detail_1",
            confidence: 0.9,
            probabilities: { detail_1: 0.9, stop: 0.1 },
          },
        },
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
    );
    const provider = createJevDecisionProvider({ getApiKey: async () => "test", fetch: fetcher });
    const input = {
      delta,
      candidates: [],
      actions: [{ id: "detail_1", kind: "detail" as const, candidateKey: "episodic:one" }],
    };
    await expect(provider.chooseExpansion!(input, new AbortController().signal)).resolves.toBe(
      "detail_1",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).questions.next).toMatchObject({
      type: "choice",
      criteria: { stop: expect.any(String), detail_1: expect.any(String) },
    });
    fetcher.mockResolvedValueOnce(
      Response.json({
        model: "jev",
        answers: {
          continue: { type: "noul", noul: 0.95 },
          next: {
            type: "choice",
            choice: "invented",
            confidence: 1,
            probabilities: { invented: 1 },
          },
        },
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
    );
    await expect(
      provider.chooseExpansion!(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "attention_response_invalid" });
    const signal = new AbortController().signal;
    for (let i = 0; i < 20; i++) await provider.chooseExpansion!(input, signal);
    await expect(provider.chooseExpansion!(input, signal)).rejects.toMatchObject({
      code: "attention_budget_exhausted",
    });
    expect(fetcher).toHaveBeenCalledTimes(22);
  });
  it("uses the official typed API and validates every requested answer", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      return Response.json({
        model: "jev-1.13.0",
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.95 }]),
        ),
        usage: { input_tokens: 10, output_tokens: 3 },
      });
    });
    const provider = createJevDecisionProvider({
      getApiKey: async () => "test-key",
      fetch: fetcher,
    });
    await provider.validate();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
    fetcher.mockResolvedValueOnce(
      Response.json({ model: "jev", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
    );
    await expect(provider.validate()).rejects.toMatchObject({
      code: "attention_response_invalid",
      retryable: false,
    });
  });
  it("does not retry rejected credentials or expose upstream response bodies", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("private upstream text", { status: 401 }),
    );
    const provider = createJevDecisionProvider({ getApiKey: async () => "secret", fetch: fetcher });
    await expect(provider.validate()).rejects.toMatchObject({
      message: "attention_auth_invalid",
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("retries a body transport failure and treats repeated failures as transient", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection reset after headers"));
            },
          }),
        ),
    );
    const provider = createJevDecisionProvider({ getApiKey: async () => "test", fetch: fetcher });
    await expect(provider.validate()).rejects.toMatchObject({
      code: "attention_network_unavailable",
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("cancels a stalled response body promptly without misclassifying it", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              queueMicrotask(() => abort.abort());
            },
          }),
        ),
    );
    const provider = createJevDecisionProvider({ getApiKey: async () => "test", fetch: fetcher });
    await expect(
      provider.assessRecall(
        {
          missionId: "m",
          contextId: "c",
          missionGoal: "goal",
          latestObservation: "error",
          lastAction: "tool",
          trigger: "new_error",
          concepts: [],
        },
        abort.signal,
      ),
    ).rejects.toMatchObject({ code: "attention_cancelled", retryable: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("revalidates authorization before each batch and retry", async () => {
    const guard = vi.fn(async () => {
      throw new Error("attention_cancelled");
    });
    const fetcher = vi.fn<typeof fetch>();
    const provider = createJevDecisionProvider({ getApiKey: async () => "test", fetch: fetcher });
    await expect(
      provider.assessRecall(
        {
          missionId: "m",
          contextId: "c",
          missionGoal: "goal",
          latestObservation: "error",
          lastAction: "tool",
          trigger: "new_error",
          concepts: [],
        },
        new AbortController().signal,
        guard,
      ),
    ).rejects.toThrow("attention_cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks the scope again before retrying a previously authorized request", async () => {
    let allowed = true;
    const guard = vi.fn(async () => {
      if (!allowed) throw new Error("attention_cancelled");
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      allowed = false;
      return new Response(null, { status: 503 });
    });
    const provider = createJevDecisionProvider({ getApiKey: async () => "test", fetch: fetcher });
    await expect(
      provider.assessRecall(
        {
          missionId: "m",
          contextId: "c",
          missionGoal: "goal",
          latestObservation: "error",
          lastAction: "tool",
          trigger: "new_error",
          concepts: [],
        },
        new AbortController().signal,
        guard,
      ),
    ).rejects.toThrow("attention_cancelled");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledTimes(2);
  });
  it("bounds a stalled body even if the injected transport ignores the deadline", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream()));
    const provider = createJevDecisionProvider({ getApiKey: async () => "test", fetch: fetcher });
    await expect(provider.validate()).rejects.toMatchObject({
      code: "attention_network_unavailable",
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  }, 10_000);
  it("keeps a full eight-item transition within the HTTP budget", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(24_576);
      return Response.json({
        model: "jev",
        answers: { changed: { type: "noul", noul: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const candidates = Array.from({ length: 16 }, (_, index) => ({
      module: "episodic" as const,
      memoryId: String(index).padStart(36, "a"),
      revision: 1,
      title: "t".repeat(180),
      summary: "s".repeat(800),
    }));
    const entries = candidates.map((candidate) => ({
      module: candidate.module,
      memoryId: candidate.memoryId,
      revision: 1,
      relevance: 0.9,
      reason: "new_observation" as const,
      decisionMode: "provider" as const,
      pinned: false as const,
      selectedPaths: [],
      firstActivatedAt: "2026-09-28T00:00:00Z",
      lastRelevantAt: "2026-09-28T00:00:00Z",
    }));
    const provider = createJevDecisionProvider({ getApiKey: async () => "test", fetch: fetcher });
    await expect(
      provider.assessAttention(
        {
          delta: {
            missionId: "m",
            contextId: "c",
            missionGoal: "g".repeat(800),
            latestObservation: "e".repeat(1200),
            lastAction: "a".repeat(200),
            trigger: "new_error",
            concepts: Array.from({ length: 12 }, () => "c".repeat(128)),
          },
          previous: entries.slice(0, 8),
          next: entries.slice(8),
          candidates,
        },
        new AbortController().signal,
      ),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
