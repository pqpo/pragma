import {
  parseRuntimeModelCatalogModels,
  readRuntimeModelCatalogCache,
  retryRuntimeModelDiscovery,
  writeRuntimeModelCatalogCache,
} from "@pragma/core";
import { runRuntimeCommand } from "@pragma/core/runtime/process-probe";
import type {
  RuntimeModel,
  RuntimeModelDiscoveryOptions,
  RuntimeThinkingLevel,
} from "@pragma/core/runtime/runtime-adapter";
import { BoundedLruCache } from "@pragma/shared";

import { resolveCodexExecutablePath } from "./executable.ts";
import type { CodexRuntimeAdapterOptions } from "./types.ts";

interface CodexDebugModelsResponse {
  readonly models?: readonly CodexDebugModel[] | undefined;
}

interface CodexDebugModel {
  readonly slug?: string | undefined;
  readonly display_name?: string | undefined;
  readonly input_modalities?: readonly string[] | undefined;
  readonly default_reasoning_level?: string | undefined;
  readonly supported_reasoning_levels?:
    | readonly {
        readonly effort?: string | undefined;
        readonly description?: string | undefined;
      }[]
    | undefined;
  readonly priority?: number | undefined;
  readonly visibility?: string | undefined;
}

interface CatalogCacheEntry {
  readonly expiresAt: number;
  readonly retryAt?: number | undefined;
  readonly models: readonly RuntimeModel[];
}

interface CatalogRefreshResult {
  readonly models: readonly RuntimeModel[];
  readonly fresh: boolean;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1_000;
const DISCOVERY_RETRY_DELAY_MS = 30 * 1_000;
const DISCOVERY_OUTPUT_LIMIT = 16 * 1024 * 1024;
const CATALOG_CACHE_CAPACITY = 64;
const catalogCache = new BoundedLruCache<string, CatalogCacheEntry>(CATALOG_CACHE_CAPACITY);
const catalogRefreshes = new Map<string, Promise<CatalogRefreshResult>>();
const customSpawnIds = new WeakMap<NonNullable<CodexRuntimeAdapterOptions["spawn"]>, number>();
let nextCustomSpawnId = 1;

const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export function createCodexModelDiscovery(
  options: CodexRuntimeAdapterOptions,
): (request?: RuntimeModelDiscoveryOptions) => Promise<readonly RuntimeModel[]> {
  return async (request = {}) => {
    const executablePath =
      options.executablePath ??
      (options.spawn === undefined ? resolveCodexExecutablePath(options) : "codex");
    const env = { ...(options.env ?? process.env) };
    const cacheEnvironment = options.env ?? stableProcessEnvironment(process.env);
    const cacheKey = discoveryCacheKey(
      executablePath,
      options.spawn,
      options.modelCatalogCacheRoot,
      cacheEnvironment,
    );
    const cached = catalogCache.get(cacheKey);
    const persistedPromise =
      cached === undefined || request.forceRefresh === true
        ? readRuntimeModelCatalogCache(
            {
              runtimeId: "codex",
              cacheKey,
              cacheRoot: options.modelCatalogCacheRoot,
            },
            parseRuntimeModelCatalogModels,
          )
        : Promise.resolve(undefined);

    if (request.forceRefresh === true) {
      const persisted = await persistedPromise;
      const result = await refreshCodexModelCatalog({
        cacheKey,
        executablePath,
        env,
        spawn: options.spawn,
        cacheRoot: options.modelCatalogCacheRoot,
        fallback: cached?.models ?? persisted,
      });
      if (result.fresh) notifyModelCatalogUpdated(options.onModelCatalogUpdated);
      return result.models;
    }

    if (cached !== undefined) {
      const now = Date.now();
      if (cached.expiresAt <= now && (cached.retryAt ?? 0) <= now) {
        const refresh = refreshCodexModelCatalog({
          cacheKey,
          executablePath,
          env,
          spawn: options.spawn,
          cacheRoot: options.modelCatalogCacheRoot,
          fallback: cached.models,
        });
        void refresh.then(
          (result) => {
            if (result.fresh) notifyModelCatalogUpdated(options.onModelCatalogUpdated);
          },
          () => undefined,
        );
      }
      return cached.models;
    }

    const refresh = refreshCodexModelCatalog({
      cacheKey,
      executablePath,
      env,
      spawn: options.spawn,
      cacheRoot: options.modelCatalogCacheRoot,
      fallbackPromise: persistedPromise,
    });
    const persisted = await persistedPromise;
    if (persisted !== undefined) {
      if (catalogCache.get(cacheKey) === undefined) {
        catalogCache.set(cacheKey, {
          expiresAt: Date.now(),
          models: persisted,
        });
      }
      void refresh.then(
        (result) => {
          if (result.fresh) notifyModelCatalogUpdated(options.onModelCatalogUpdated);
        },
        () => undefined,
      );
      return catalogCache.get(cacheKey)?.models ?? persisted;
    }

    return (await refresh).models;
  };
}

function refreshCodexModelCatalog(input: {
  readonly cacheKey: string;
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn: CodexRuntimeAdapterOptions["spawn"];
  readonly cacheRoot?: string | undefined;
  readonly fallback?: readonly RuntimeModel[] | undefined;
  readonly fallbackPromise?: Promise<readonly RuntimeModel[] | undefined> | undefined;
}): Promise<CatalogRefreshResult> {
  const { cacheKey } = input;
  const activeRefresh = catalogRefreshes.get(cacheKey);
  if (activeRefresh !== undefined) return activeRefresh;

  const refresh = (async () => {
    try {
      const models = await retryRuntimeModelDiscovery(async () => {
        const result = await runRuntimeCommand({
          executablePath: input.executablePath,
          args: ["debug", "models", "--bundled"],
          cwd: process.cwd(),
          env: input.env,
          timeoutMs: 15_000,
          outputLimit: DISCOVERY_OUTPUT_LIMIT,
          spawn: input.spawn,
        });
        if (result.exitCode !== 0) {
          throw new Error(createDiscoveryError("model discovery failed", result.stderr));
        }
        const discovered = parseCodexModels(result.stdout);
        if (discovered.length === 0) {
          throw new Error("Codex model discovery returned no supported models.");
        }
        return discovered;
      });

      catalogCache.set(cacheKey, {
        expiresAt: Date.now() + DISCOVERY_TTL_MS,
        models,
      });
      await writeRuntimeModelCatalogCache(
        {
          runtimeId: "codex",
          cacheKey,
          cacheRoot: input.cacheRoot,
        },
        models,
      );
      return { models, fresh: true };
    } catch (error) {
      const fallback =
        catalogCache.get(cacheKey)?.models ??
        input.fallback ??
        (input.fallbackPromise === undefined ? undefined : await input.fallbackPromise);
      if (fallback !== undefined) {
        catalogCache.set(cacheKey, {
          expiresAt: Date.now(),
          retryAt: Date.now() + DISCOVERY_RETRY_DELAY_MS,
          models: fallback,
        });
        return { models: fallback, fresh: false };
      }
      throw error;
    }
  })().catch((error: unknown) => {
    const cached = catalogCache.get(cacheKey);
    if (cached !== undefined) {
      catalogCache.set(cacheKey, {
        ...cached,
        retryAt: Date.now() + DISCOVERY_RETRY_DELAY_MS,
      });
    }
    throw error;
  });
  catalogRefreshes.set(cacheKey, refresh);
  void refresh.then(clearRefresh, clearRefresh);
  return refresh;

  function clearRefresh(): void {
    if (catalogRefreshes.get(cacheKey) === refresh) {
      catalogRefreshes.delete(cacheKey);
    }
  }
}

function notifyModelCatalogUpdated(listener: (() => void) | undefined): void {
  try {
    listener?.();
  } catch {
    // A host notification is best-effort and must not turn a successful refresh into a failure.
  }
}

function discoveryCacheKey(
  executablePath: string,
  spawn: CodexRuntimeAdapterOptions["spawn"],
  cacheRoot: string | undefined,
  env: Readonly<NodeJS.ProcessEnv>,
): string {
  const root = cacheRoot ?? "default";
  const envFingerprint = JSON.stringify(
    Object.entries(env).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  if (spawn === undefined) return `${executablePath}\u0000root:${root}\u0000env:${envFingerprint}`;
  let spawnId = customSpawnIds.get(spawn);
  if (spawnId === undefined) {
    spawnId = nextCustomSpawnId;
    nextCustomSpawnId += 1;
    customSpawnIds.set(spawn, spawnId);
  }
  return `${executablePath}\u0000root:${root}\u0000env:${envFingerprint}\u0000spawn:${spawnId}`;
}

const CODEX_CACHE_ENV_KEYS = [
  "CODEX_HOME",
  "HOME",
  "PATH",
  "PATHEXT",
  "NVM_DIR",
  "NVM_BIN",
] as const;

function stableProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    CODEX_CACHE_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export function parseCodexModels(output: string): readonly RuntimeModel[] {
  let response: CodexDebugModelsResponse;

  try {
    response = JSON.parse(output) as CodexDebugModelsResponse;
  } catch {
    return [];
  }

  const visibleModels = (response.models ?? []).filter(
    (model): model is CodexDebugModel & { readonly slug: string } =>
      typeof model.slug === "string" && model.slug.trim() !== "" && model.visibility !== "hide",
  );
  const defaultModel = visibleModels.reduce<CodexDebugModel | undefined>((current, model) => {
    if (current === undefined) {
      return model;
    }
    return (model.priority ?? Number.MAX_SAFE_INTEGER) <
      (current.priority ?? Number.MAX_SAFE_INTEGER)
      ? model
      : current;
  }, undefined);

  return visibleModels.map((model) => {
    const levels = (model.supported_reasoning_levels ?? []).flatMap((level) => {
      const value = level.effort?.trim();
      if (value === undefined || value === "") {
        return [];
      }
      return [
        {
          value,
          label: THINKING_LEVEL_LABELS[value] ?? toDisplayLabel(value),
          ...(level.description === undefined ? {} : { description: level.description }),
        } satisfies RuntimeThinkingLevel,
      ];
    });
    const defaultLevel = levels.some((level) => level.value === model.default_reasoning_level)
      ? model.default_reasoning_level
      : undefined;

    return {
      id: model.slug,
      displayName: model.display_name?.trim() || model.slug,
      provider: { kind: "runtime-managed", id: "openai", displayName: "OpenAI" },
      ...(model === defaultModel ? { default: true } : {}),
      inputModalities: normalizeInputModalities(model.input_modalities),
      ...(levels.length === 0
        ? {}
        : {
            thinking: {
              supportedLevels: levels,
              ...(defaultLevel === undefined ? {} : { defaultLevel }),
            },
          }),
    } satisfies RuntimeModel;
  });
}

function normalizeInputModalities(input: readonly string[] | undefined): readonly string[] {
  const normalized = [
    ...new Set(
      (input ?? ["text", "image"])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value !== ""),
    ),
  ];
  return normalized.length === 0 ? ["text"] : normalized;
}

export function assertCodexModelSelection(
  models: readonly RuntimeModel[],
  modelName: string | undefined,
  thinkingLevel: string | undefined,
): void {
  if (modelName === undefined && thinkingLevel === undefined) {
    return;
  }

  const model =
    modelName === undefined
      ? models.find((candidate) => candidate.default)
      : models.find((candidate) => candidate.id === modelName);

  if (model === undefined) {
    throw new Error(
      modelName === undefined
        ? `Codex thinking level "${thinkingLevel}" cannot be validated because the discovered catalog has no default model.`
        : `Unsupported Codex model "${modelName}".`,
    );
  }

  if (
    thinkingLevel !== undefined &&
    !model.thinking?.supportedLevels.some((level) => level.value === thinkingLevel)
  ) {
    throw new Error(`Unsupported Codex thinking level "${thinkingLevel}" for model "${model.id}".`);
  }
}

function createDiscoveryError(summary: string, stderr: string): string {
  const detail = firstNonEmptyLine(stderr);
  return `Codex ${summary}${detail === undefined ? "." : `: ${detail}`}`;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
}

function toDisplayLabel(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
