import type { Context, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelProviderProbeResult, ResolvedModelProvider } from "@pragma/core";

import { createPiModelProviderConverter, createPiModelRuntime } from "./models.ts";

const PROBE_TIMEOUT_MS = 15_000;

export async function probePiModelProvider(options: {
  readonly provider: ResolvedModelProvider;
  readonly modelId: string;
  readonly thinkingLevel?: ModelThinkingLevel | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ModelProviderProbeResult> {
  const converter = createPiModelProviderConverter();
  const configuredModel = options.provider.models.find((model) => model.id === options.modelId);
  if (configuredModel === undefined) {
    return {
      ok: false,
      code: "model_unavailable",
      message: "The model is not configured for this provider.",
    };
  }
  const api = configuredModel.api ?? options.provider.api;
  if (!converter.supports(api)) {
    return {
      ok: false,
      code: "unsupported_protocol",
      message: `Connection testing is not supported for API protocol "${api}".`,
    };
  }

  const nativeProvider = converter.convertProvider(options.provider);
  const { modelRegistry, modelRuntime } = await createPiModelRuntime([nativeProvider]);
  const model = modelRegistry
    .getAll()
    .find(
      (candidate) => candidate.provider === options.provider.id && candidate.id === options.modelId,
    );
  if (model === undefined) {
    return {
      ok: false,
      code: "model_unavailable",
      message: "The configured model could not be registered.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const startedAt = Date.now();
  let responseStatus: number | undefined;
  const thinkingLevel = options.thinkingLevel ?? configuredModel.thinking?.defaultLevel;
  const context: Context = {
    systemPrompt: "You are a connection test. Follow the user instruction exactly.",
    messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
  };

  try {
    const result = await modelRuntime.completeSimple(model, context, {
      signal: controller.signal,
      maxTokens: 8,
      maxRetries: 0,
      onResponse: (response) => {
        responseStatus = response.status;
      },
      ...(thinkingLevel === undefined || thinkingLevel === "off"
        ? {}
        : { reasoning: thinkingLevel }),
    });
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return classifyFailure(result.errorMessage ?? "The provider rejected the probe request.", {
        aborted: result.stopReason === "aborted",
        status: responseStatus,
      });
    }
    return {
      ok: true,
      code: "success",
      message: "Connection successful.",
      latencyMs: Date.now() - startedAt,
      ...(responseStatus === undefined ? {} : { status: responseStatus }),
    };
  } catch (error) {
    return classifyFailure(error instanceof Error ? error.message : String(error), {
      aborted:
        controller.signal.aborted ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")),
      status: responseStatus ?? errorStatus(error),
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function classifyFailure(
  message: string,
  options: { readonly aborted: boolean; readonly status?: number | undefined },
): ModelProviderProbeResult {
  if (options.aborted) {
    return { ok: false, code: "timeout", message: "The request timed out after 15 seconds." };
  }
  const status = options.status ?? statusFromMessage(message);
  if (status === 401 || status === 403) {
    return { ok: false, code: "authentication", message, status };
  }
  if (status === 404) {
    return { ok: false, code: "model_unavailable", message, status };
  }
  if (status !== undefined) {
    return { ok: false, code: "request_failed", message, status };
  }
  return { ok: false, code: "network", message };
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function statusFromMessage(message: string): number | undefined {
  const matched = /\b([45]\d{2})\b/.exec(message);
  if (matched?.[1] === undefined) return undefined;
  const status = Number(matched[1]);
  return Number.isInteger(status) ? status : undefined;
}
