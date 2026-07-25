import type {
  RuntimeContextWindowMeasurement,
  RuntimeContextWindowUsage,
} from "./runtime-adapter.ts";

export function createRuntimeContextWindowUsage(input: {
  readonly usedTokens: number | null;
  readonly contextWindowTokens: number;
  readonly measurement: RuntimeContextWindowMeasurement;
  readonly observedAt?: string | undefined;
}): RuntimeContextWindowUsage {
  const contextWindowTokens = normalizePositiveTokenCount(
    input.contextWindowTokens,
    "Context window",
  );
  const usedTokens =
    input.usedTokens === null ? null : normalizeNonNegativeTokenCount(input.usedTokens, "Used");

  return {
    usedTokens,
    contextWindowTokens,
    percent: usedTokens === null ? null : (usedTokens / contextWindowTokens) * 100,
    measurement: input.measurement,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}

function normalizePositiveTokenCount(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} token count must be a positive finite number.`);
  }
  return Math.round(value);
}

function normalizeNonNegativeTokenCount(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} token count must be a non-negative finite number.`);
  }
  return Math.round(value);
}
