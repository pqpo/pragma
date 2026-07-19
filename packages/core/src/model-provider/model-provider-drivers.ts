import type { ModelApi, ProviderModelDefinition } from "@pragma/shared";

import type {
  ModelProviderDirectory,
  ModelProviderDiscoveryRequest,
  ModelProviderDiscoveryResult,
  ModelProviderDriver,
  ModelProviderDriverRegistry,
  ModelProviderProbeResult,
} from "./model-provider.ts";

const DISCOVERY_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export function createBuiltInModelProviderDriverRegistry(
  options: {
    readonly fetch?: typeof fetch | undefined;
  } = {},
): ModelProviderDriverRegistry {
  const fetchImpl = options.fetch ?? fetch;
  const drivers = new Map<ModelApi, ModelProviderDriver>(
    [
      createDriver("openai-completions", fetchImpl),
      createDriver("openai-responses", fetchImpl),
      createDriver("anthropic-messages", fetchImpl),
      createDriver("google-generative-ai", fetchImpl),
      createDriver("mistral-conversations", fetchImpl),
    ].map((driver) => [driver.api, driver]),
  );
  return { get: (api) => drivers.get(api) };
}

export async function discoverModelProviderModels(options: {
  readonly request: ModelProviderDiscoveryRequest;
  readonly drivers: ModelProviderDriverRegistry;
  readonly directory: ModelProviderDirectory;
}): Promise<ModelProviderDiscoveryResult> {
  const suggested = options.directory.listModels(options.request.catalogId);
  if (!options.request.supportsDiscovery) return catalogFallback(suggested);

  const driver = options.drivers.get(options.request.api);
  if (driver === undefined) {
    return fallback(
      suggested,
      `Model discovery is not supported for API protocol "${options.request.api}".`,
    );
  }

  try {
    const ids = await driver.discover({
      baseUrl: options.request.baseUrl,
      apiKey: options.request.apiKey,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const suggestedById = new Map(suggested.map((model) => [model.id, model]));
    const models = ids.map(
      (id) => suggestedById.get(id) ?? createUnknownProviderModel(id, options.request.api),
    );
    return models.length > 0
      ? { ok: true, models, source: "provider", message: `Found ${models.length} models.` }
      : fallback(suggested, "The provider returned no usable models.");
  } catch (error) {
    return fallback(
      suggested,
      error instanceof Error
        ? `Model discovery failed: ${error.message}`
        : "Model discovery failed.",
    );
  }
}

export async function probeModelProvider(options: {
  readonly api: ModelApi;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: ProviderModelDefinition;
  readonly drivers: ModelProviderDriverRegistry;
}): Promise<ModelProviderProbeResult> {
  const api = options.model.api ?? options.api;
  const driver = options.drivers.get(api);
  if (driver === undefined) {
    return {
      ok: false,
      code: "unsupported_protocol",
      message: `Connection testing is not supported for API protocol "${api}".`,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await driver.probe({
      baseUrl: options.model.baseUrl ?? options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, code: "timeout", message: "The request timed out after 15 seconds." };
    }
    return {
      ok: false,
      code: "network",
      message: error instanceof Error ? error.message : "The API request could not be completed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createUnknownProviderModel(id: string, api: ModelApi): ProviderModelDefinition {
  return {
    id,
    name: id,
    api,
    reasoning: false,
    input: ["text"],
    cost: DEFAULT_COST,
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function createDriver(api: ModelApi, fetchImpl: typeof fetch): ModelProviderDriver {
  return {
    api,
    async discover(options) {
      const endpoint =
        api === "anthropic-messages"
          ? anthropicEndpointUrl(options.baseUrl, "models")
          : endpointUrl(options.baseUrl, "models");
      if (api === "google-generative-ai" && options.apiKey !== "") {
        endpoint.searchParams.set("key", options.apiKey);
      }
      const response = await fetchImpl(endpoint, {
        headers: requestHeaders(api, options.apiKey, false),
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`The provider returned HTTP ${response.status}.`);
      return extractModelIds(await response.json(), api);
    },
    async probe(options) {
      const startedAt = Date.now();
      const request = createProbeRequest(api, options);
      const response = await fetchImpl(request.endpoint, {
        method: "POST",
        headers: requestHeaders(api, options.apiKey, true),
        body: JSON.stringify(request.body),
        signal: options.signal,
      });
      if (!response.ok) return httpFailure(response.status);
      const body: unknown = await response.json().catch(() => null);
      if (!isValidProbeResponse(api, body)) {
        return {
          ok: false,
          code: "invalid_response",
          message: "The provider returned an unexpected response.",
        };
      }
      return {
        ok: true,
        code: "success",
        message: "Connection successful.",
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}

function createProbeRequest(
  api: ModelApi,
  options: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: ProviderModelDefinition;
  },
): { readonly endpoint: URL; readonly body: Record<string, unknown> } {
  switch (api) {
    case "openai-responses":
      return {
        endpoint: endpointUrl(options.baseUrl, "responses"),
        body: { model: options.model.id, input: "Reply with OK.", max_output_tokens: 1 },
      };
    case "anthropic-messages":
      return {
        endpoint: anthropicEndpointUrl(options.baseUrl, "messages"),
        body: {
          model: options.model.id,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
        },
      };
    case "google-generative-ai": {
      const endpoint = endpointUrl(
        options.baseUrl,
        `models/${encodeURIComponent(options.model.id)}:generateContent`,
      );
      if (options.apiKey !== "") endpoint.searchParams.set("key", options.apiKey);
      return {
        endpoint,
        body: {
          contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      };
    }
    case "mistral-conversations":
    case "openai-completions":
    default:
      return {
        endpoint: endpointUrl(options.baseUrl, "chat/completions"),
        body: {
          model: options.model.id,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        },
      };
  }
}

function requestHeaders(
  api: ModelApi,
  apiKey: string,
  includeContentType: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (includeContentType) headers["Content-Type"] = "application/json";
  if (api === "anthropic-messages") {
    if (apiKey !== "") headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (api !== "google-generative-ai" && apiKey !== "") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

function endpointUrl(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function anthropicEndpointUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  return endpointUrl(baseUrl, basePath.endsWith("/v1") ? path : `v1/${path}`);
}

function extractModelIds(body: unknown, api: ModelApi): string[] {
  if (!body || typeof body !== "object") return [];
  const candidates = Array.isArray((body as { data?: unknown }).data)
    ? (body as { data: unknown[] }).data
    : Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: unknown[] }).models
      : [];
  const ids = candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") return undefined;
      const value =
        (candidate as { id?: unknown; name?: unknown }).id ??
        (candidate as { name?: unknown }).name;
      if (typeof value !== "string") return undefined;
      return api === "google-generative-ai" ? value.replace(/^models\//, "") : value;
    })
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function isValidProbeResponse(api: ModelApi, body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  switch (api) {
    case "openai-completions":
    case "mistral-conversations":
      return Array.isArray((body as { choices?: unknown }).choices);
    case "openai-responses":
      return "output" in body || "output_text" in body || "id" in body;
    case "anthropic-messages":
      return Array.isArray((body as { content?: unknown }).content);
    case "google-generative-ai":
      return Array.isArray((body as { candidates?: unknown }).candidates);
    default:
      return false;
  }
}

function httpFailure(status: number): ModelProviderProbeResult {
  const code =
    status === 401 || status === 403
      ? "authentication"
      : status === 404
        ? "model_unavailable"
        : "request_failed";
  return { ok: false, code, message: `The API returned HTTP ${status}.`, status };
}

function catalogFallback(models: readonly ProviderModelDefinition[]): ModelProviderDiscoveryResult {
  return models.length > 0
    ? { ok: true, models, source: "catalog", message: "Using the Pragma model catalog." }
    : {
        ok: false,
        models: [],
        source: "manual",
        message: "This provider does not expose model discovery. Add a model ID manually.",
      };
}

function fallback(
  models: readonly ProviderModelDefinition[],
  message: string,
): ModelProviderDiscoveryResult {
  return {
    ok: false,
    models,
    source: models.length > 0 ? "catalog" : "manual",
    message: `${message} ${
      models.length > 0
        ? "You can still choose a suggested model or add one manually."
        : "Add a model ID manually."
    }`,
  };
}
