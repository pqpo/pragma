import { runRuntimeCommand } from "@pragma/core/runtime/process-probe";
import type { RuntimeModel, RuntimeThinkingLevel } from "@pragma/core/runtime/runtime-adapter";
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

const DISCOVERY_TTL_MS = 10 * 60 * 1_000;
const DISCOVERY_RETRY_DELAY_MS = 30 * 1_000;
const DISCOVERY_OUTPUT_LIMIT = 16 * 1024 * 1024;
const CATALOG_CACHE_CAPACITY = 64;
const catalogCache = new BoundedLruCache<string, CatalogCacheEntry>(CATALOG_CACHE_CAPACITY);
const catalogRefreshes = new Map<string, Promise<readonly RuntimeModel[]>>();
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
): () => Promise<readonly RuntimeModel[]> {
  return async () => {
    const executablePath =
      options.executablePath ??
      (options.spawn === undefined ? resolveCodexExecutablePath(options) : "codex");
    const env = { ...process.env, ...(options.env ?? {}) };
    const cacheKey = discoveryCacheKey(executablePath, options.spawn);
    const cached = catalogCache.get(cacheKey);

    if (cached !== undefined) {
      const now = Date.now();
      if (cached.expiresAt <= now && (cached.retryAt ?? 0) <= now) {
        const refresh = refreshCodexModelCatalog(cacheKey, executablePath, env, options.spawn);
        void refresh.then(
          () => notifyModelCatalogUpdated(options.onModelCatalogUpdated),
          () => undefined,
        );
      }
      return cached.models;
    }

    return await refreshCodexModelCatalog(cacheKey, executablePath, env, options.spawn);
  };
}

function refreshCodexModelCatalog(
  cacheKey: string,
  executablePath: string,
  env: NodeJS.ProcessEnv,
  spawn: CodexRuntimeAdapterOptions["spawn"],
): Promise<readonly RuntimeModel[]> {
  const activeRefresh = catalogRefreshes.get(cacheKey);
  if (activeRefresh !== undefined) return activeRefresh;

  const refresh = (async () => {
    const result = await runRuntimeCommand({
      executablePath,
      args: ["debug", "models", "--bundled"],
      cwd: process.cwd(),
      env,
      timeoutMs: 15_000,
      outputLimit: DISCOVERY_OUTPUT_LIMIT,
      spawn,
    });

    if (result.exitCode !== 0) {
      throw new Error(createDiscoveryError("model discovery failed", result.stderr));
    }

    const models = parseCodexModels(result.stdout);
    if (models.length === 0) {
      throw new Error("Codex model discovery returned no supported models.");
    }

    catalogCache.set(cacheKey, {
      expiresAt: Date.now() + DISCOVERY_TTL_MS,
      models,
    });
    return models;
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
): string {
  if (spawn === undefined) return executablePath;
  let spawnId = customSpawnIds.get(spawn);
  if (spawnId === undefined) {
    spawnId = nextCustomSpawnId;
    nextCustomSpawnId += 1;
    customSpawnIds.set(spawn, spawnId);
  }
  return `${executablePath}\u0000spawn:${spawnId}`;
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
