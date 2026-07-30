import type { PragmaLogger } from "../logging/logger.ts";

export type RuntimeTokenCountSource = "heuristic" | "tokenizer";

export interface RuntimeTokenModelIdentity {
  readonly runtimeKind?: string | undefined;
  readonly providerCatalogId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly api?: string | undefined;
  readonly modelId?: string | undefined;
}

export interface RuntimeTokenCountResult {
  readonly tokens: number;
  readonly source: RuntimeTokenCountSource;
}

export interface RuntimeTokenCounter {
  countText(value: string, model?: RuntimeTokenModelIdentity | undefined): RuntimeTokenCountResult;
  subscribe?(listener: () => void): (() => void) | undefined;
}

export interface LazyRuntimeTokenCounter extends RuntimeTokenCounter {
  subscribe(listener: () => void): () => void;
  load(): Promise<boolean>;
  dispose(): void;
}

export interface CreateRuntimeTokenCounterOptions {
  readonly logger?: Pick<PragmaLogger, "info" | "warn"> | undefined;
}

type CountTokens = (value: string) => number;

let sharedTokenizerLoad: Promise<CountTokens> | undefined;

export function createRuntimeTokenCounter(
  options: CreateRuntimeTokenCounterOptions = {},
): LazyRuntimeTokenCounter {
  const listeners = new Set<() => void>();
  let tokenizer: CountTokens | undefined;
  let loadOperation: Promise<boolean> | undefined;
  let disposed = false;

  const load = (): Promise<boolean> => {
    if (tokenizer !== undefined) return Promise.resolve(true);
    if (disposed) return Promise.resolve(false);
    if (loadOperation !== undefined) return loadOperation;

    loadOperation = loadSharedTokenizer()
      .then((loaded) => {
        if (disposed) return false;
        tokenizer = loaded;
        options.logger?.info(
          "token_counter.tokenizer_ready",
          "The shared local tokenizer is ready.",
        );
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            // An observer must not prevent the tokenizer from becoming active.
          }
        }
        return true;
      })
      .catch((error: unknown) => {
        options.logger?.warn(
          "token_counter.tokenizer_load_failed",
          "The shared local tokenizer could not be loaded; the heuristic remains active.",
          { error },
        );
        return false;
      });
    return loadOperation;
  };

  return {
    countText(value) {
      if (tokenizer === undefined) {
        void load();
        return {
          tokens: estimateUnicodeTokens(value),
          source: "heuristic",
        };
      }

      try {
        return {
          tokens: normalizeTokenCount(tokenizer(value)),
          source: "tokenizer",
        };
      } catch {
        return {
          tokens: estimateUnicodeTokens(value),
          source: "heuristic",
        };
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

export const defaultRuntimeTokenCounter: RuntimeTokenCounter = createRuntimeTokenCounter();

function estimateUnicodeTokens(value: string): number {
  if (value === "") return 0;

  let asciiCodePoints = 0;
  let nonAsciiUtf8Bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x7f) {
      asciiCodePoints += 1;
    } else {
      nonAsciiUtf8Bytes += Buffer.byteLength(character, "utf8");
    }
  }

  return Math.ceil(asciiCodePoints / 4) + Math.ceil(nonAsciiUtf8Bytes / 3);
}

function loadSharedTokenizer(): Promise<CountTokens> {
  sharedTokenizerLoad ??= import("gpt-tokenizer/encoding/o200k_base").then(
    ({ countTokens }) =>
      (value: string): number =>
        countTokens(value),
  );
  return sharedTokenizerLoad;
}

function normalizeTokenCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Tokenizer returned an invalid token count.");
  }
  return Math.round(value);
}
