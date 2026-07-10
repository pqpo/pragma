import type { ModelConnectionTestResult } from "../shared/desktop-api.ts";

const TEST_TIMEOUT_MS = 15_000;

export async function testOpenAiCompatibleModel(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<ModelConnectionTestResult> {
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL(
    "chat/completions",
    options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
  );

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.modelId,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 404
          ? "model_unavailable"
          : "request_failed";
      return {
        ok: false,
        code,
        message: `The API returned HTTP ${response.status}.`,
        status: response.status,
      };
    }

    const body: unknown = await response.json().catch(() => null);
    if (!body || typeof body !== "object" || !Array.isArray((body as { choices?: unknown }).choices)) {
      return {
        ok: false,
        code: "invalid_response",
        message: "The API did not return an OpenAI-compatible completion response.",
      };
    }

    return {
      ok: true,
      code: "success",
      message: "Connection successful.",
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ok: false, code: "timeout", message: "The request timed out after 15 seconds." };
    }
    return { ok: false, code: "network", message: "The API request could not be completed." };
  }
}
