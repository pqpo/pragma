import { defaultRuntimeTokenCounter, type RuntimeTokenCounter } from "@pragma/core";
import { z } from "zod";

import { EmbeddingProfileSchema, type EmbeddingProfile } from "./profile.ts";
export { EmbeddingProfileSchema, type EmbeddingProfile } from "./profile.ts";
export class EmbeddingError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export interface EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  readonly retryKey?: string;
  embed(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<{
    vectors: readonly Float32Array[];
    model: string;
    dimensions: number;
    inputTokens?: number;
  }>;
  validate(signal: AbortSignal): Promise<{ dimensions: number; model: string }>;
}
export function embeddingEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new EmbeddingError("embedding_endpoint_invalid");
  }
  if (
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new EmbeddingError("embedding_endpoint_invalid");
  return new URL("embeddings", `${baseUrl.replace(/\/+$/u, "")}/`);
}
export function createOpenAIEmbeddingProvider(options: {
  profile: EmbeddingProfile;
  getApiKey: () => Promise<string>;
  fetch?: typeof fetch;
  tokenCounter?: RuntimeTokenCounter;
  beforeRequest?: () => Promise<void>;
}): EmbeddingProvider {
  const profile = EmbeddingProfileSchema.parse(options.profile);
  const counter = options.tokenCounter ?? defaultRuntimeTokenCounter;
  const embed: EmbeddingProvider["embed"] = async (texts, signal) => {
    if (
      texts.length === 0 ||
      texts.length > profile.maxBatchInputs ||
      texts.some((text) => text.trim() === "")
    )
      throw new EmbeddingError("embedding_input_invalid");
    if (texts.some((text) => counter.countText(text).tokens > profile.maxInputTokens))
      throw new EmbeddingError("embedding_input_too_large");
    const total = texts.reduce((sum, text) => sum + counter.countText(text).tokens, 0);
    if (total > profile.maxBatchTokens) throw new EmbeddingError("embedding_input_too_large");
    const body = JSON.stringify({ model: profile.modelId, input: texts, encoding_format: "float" });
    const endpoint = embeddingEndpoint(profile.baseUrl);
    let response: Response | undefined;
    let deadline = signal;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const key = await options.getApiKey();
      await options.beforeRequest?.();
      signal.throwIfAborted();
      deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      try {
        response = await (options.fetch ?? fetch)(endpoint, {
          method: "POST",
          redirect: "error",
          body,
          headers: {
            "Content-Type": "application/json",
            ...(key === "" ? {} : { Authorization: `Bearer ${key}` }),
          },
          signal: deadline,
        });
      } catch {
        signal.throwIfAborted();
        if (attempt === 1) throw new EmbeddingError("embedding_network_unavailable", true);
        continue;
      }
      if (response.ok) break;
      const status = response.status;
      // Only inspect bounded error metadata, never persist the body or use it as instructions.
      const raw = await boundedJson(response, deadline, 16_384).catch(() => undefined);
      const code =
        typeof raw === "object" &&
        raw !== null &&
        "error" in raw &&
        typeof raw.error === "object" &&
        raw.error !== null &&
        "code" in raw.error
          ? raw.error.code
          : undefined;
      if (status === 413 || code === "context_length_exceeded" || code === "input_too_long")
        throw new EmbeddingError("embedding_input_too_large");
      if (status === 401 || status === 403) throw new EmbeddingError("embedding_auth_invalid");
      if (status === 429 || status >= 500) {
        if (attempt === 0) continue;
        throw new EmbeddingError("embedding_provider_unavailable", true);
      }
      throw new EmbeddingError("embedding_request_invalid");
    }
    if (response === undefined || !response.ok)
      throw new EmbeddingError("embedding_provider_unavailable", true);
    let raw: unknown;
    try {
      raw = await boundedJson(response, deadline, 8 * 1024 * 1024);
    } catch (error) {
      signal.throwIfAborted();
      if (deadline.aborted) throw new EmbeddingError("embedding_network_unavailable", true);
      throw error;
    }
    const parsed = z
      .object({
        model: z.string().min(1),
        data: z.array(
          z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) }),
        ),
        usage: z.object({ prompt_tokens: z.number().int().nonnegative() }).optional(),
      })
      .safeParse(raw);
    if (!parsed.success || parsed.data.data.length !== texts.length)
      throw new EmbeddingError("embedding_response_invalid");
    const vectors: Float32Array[] = [];
    const seen = new Set<number>();
    let dimensions = 0;
    for (const item of parsed.data.data) {
      if (item.index >= texts.length || seen.has(item.index))
        throw new EmbeddingError("embedding_response_invalid");
      seen.add(item.index);
      if (dimensions === 0) dimensions = item.embedding.length;
      if (
        dimensions === 0 ||
        dimensions > 16_384 ||
        item.embedding.length !== dimensions ||
        item.embedding.some((value) => !Number.isFinite(value))
      )
        throw new EmbeddingError("embedding_response_invalid");
      const vector = Float32Array.from(item.embedding);
      let norm = 0;
      for (const value of vector) {
        if (!Number.isFinite(value)) throw new EmbeddingError("embedding_response_invalid");
        norm += value * value;
      }
      if (!Number.isFinite(norm) || norm === 0)
        throw new EmbeddingError("embedding_response_invalid");
      const length = Math.sqrt(norm);
      for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / length;
      vectors[item.index] = vector;
    }
    return {
      vectors,
      model: parsed.data.model,
      dimensions,
      ...(parsed.data.usage === undefined ? {} : { inputTokens: parsed.data.usage.prompt_tokens }),
    };
  };
  return {
    profile,
    embed,
    async validate(signal) {
      const texts =
        profile.maxBatchInputs >= 2 &&
        counter.countText("test").tokens * 2 <= profile.maxBatchTokens
          ? ["test", "test"]
          : ["test"];
      const result = await embed(texts, signal);
      return { dimensions: result.dimensions, model: result.model };
    },
  };
}
async function boundedJson(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new EmbeddingError("embedding_response_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxBytes) throw new EmbeddingError("embedding_response_invalid");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof EmbeddingError) throw error;
    signal.throwIfAborted();
    throw new EmbeddingError("embedding_response_invalid");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
