import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseRuntimeModelCatalogModels,
  readRuntimeModelCatalogCache,
  retryRuntimeModelDiscovery,
  writeRuntimeModelCatalogCache,
  type RuntimeModel,
  type RuntimeModelDiscoveryOptions,
} from "@pragma/core";
import { BoundedLruCache } from "@pragma/shared";

import { connectOpenCode, type OpenCodeModel } from "./client.ts";
import { prepareOpenCodeConfiguration } from "./configuration.ts";
import { prepareOpenCodeDataHome } from "./data-home.ts";
import { probeOpenCode, startOpenCodeProcess } from "./process.ts";

const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const MODEL_CATALOG_RETRY_DELAY_MS = 30_000;
const MODEL_CATALOG_CACHE_LIMIT = 64;

interface CatalogCacheEntry {
  readonly expiresAt: number;
  readonly retryAt?: number | undefined;
  readonly models: readonly RuntimeModel[];
}

interface CatalogRefreshResult {
  readonly models: readonly RuntimeModel[];
  readonly fresh: boolean;
}

export interface OpenCodeModelDiscoveryOptions {
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly modelCatalogCacheRoot?: string | undefined;
  readonly onModelCatalogUpdated?: (() => void) | undefined;
}

const catalogCache = new BoundedLruCache<string, CatalogCacheEntry>(MODEL_CATALOG_CACHE_LIMIT);
const catalogRefreshes = new Map<string, Promise<CatalogRefreshResult>>();

export function createOpenCodeModelDiscovery(
  options: OpenCodeModelDiscoveryOptions,
): (request?: RuntimeModelDiscoveryOptions) => Promise<readonly RuntimeModel[]> {
  const cacheKey = modelCatalogCacheKey(options);

  return async (request = {}) => {
    const cached = catalogCache.get(cacheKey);
    const persistedPromise =
      cached === undefined || request.forceRefresh === true
        ? readRuntimeModelCatalogCache(
            {
              runtimeId: "opencode",
              cacheKey,
              cacheRoot: options.modelCatalogCacheRoot,
            },
            parseRuntimeModelCatalogModels,
          )
        : Promise.resolve(undefined);

    if (request.forceRefresh === true) {
      const persisted = await persistedPromise;
      const result = await refreshCatalog(cached?.models ?? persisted);
      if (result.fresh) notifyModelCatalogUpdated(options.onModelCatalogUpdated);
      return result.models;
    }

    if (cached !== undefined) {
      const now = Date.now();
      if (cached.expiresAt <= now && (cached.retryAt ?? 0) <= now) {
        const refresh = refreshCatalog(cached.models);
        void refresh.then(
          (result) => {
            if (result.fresh) notifyModelCatalogUpdated(options.onModelCatalogUpdated);
          },
          () => undefined,
        );
      }
      return cached.models;
    }

    const refresh = refreshCatalog(undefined, persistedPromise);
    const persisted = await persistedPromise;
    if (persisted !== undefined) {
      if (catalogCache.get(cacheKey) === undefined) {
        catalogCache.set(cacheKey, { expiresAt: Date.now(), models: persisted });
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

  function refreshCatalog(
    fallback?: readonly RuntimeModel[] | undefined,
    fallbackPromise?: Promise<readonly RuntimeModel[] | undefined> | undefined,
  ): Promise<CatalogRefreshResult> {
    const active = catalogRefreshes.get(cacheKey);
    if (active !== undefined) return active;

    const refresh = (async () => {
      try {
        const models = await retryRuntimeModelDiscovery(
          async () => await discoverOpenCodeModels(options.executablePath, options.env),
        );
        catalogCache.set(cacheKey, {
          expiresAt: Date.now() + MODEL_CATALOG_TTL_MS,
          models,
        });
        await writeRuntimeModelCatalogCache(
          {
            runtimeId: "opencode",
            cacheKey,
            cacheRoot: options.modelCatalogCacheRoot,
          },
          models,
        );
        return { models, fresh: true };
      } catch (error) {
        const stale =
          catalogCache.get(cacheKey)?.models ??
          fallback ??
          (fallbackPromise === undefined ? undefined : await fallbackPromise);
        if (stale === undefined) throw error;
        catalogCache.set(cacheKey, {
          expiresAt: Date.now(),
          retryAt: Date.now() + MODEL_CATALOG_RETRY_DELAY_MS,
          models: stale,
        });
        return { models: stale, fresh: false };
      }
    })();
    catalogRefreshes.set(cacheKey, refresh);
    const clear = (): void => {
      if (catalogRefreshes.get(cacheKey) === refresh) catalogRefreshes.delete(cacheKey);
    };
    void refresh.then(clear, clear);
    return refresh;
  }
}

export function mapOpenCodeModel(model: OpenCodeModel): RuntimeModel {
  return {
    id: model.modelId,
    displayName: model.displayName,
    provider: {
      kind: "runtime-managed",
      id: model.providerId,
      displayName: model.providerName,
    },
    ...(model.isDefault === undefined ? {} : { default: model.isDefault }),
    ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
    ...(model.variants === undefined || model.variants.length === 0
      ? {}
      : {
          thinking: {
            supportedLevels: model.variants.map((value) => ({ value, label: value })),
          },
        }),
  };
}

async function discoverOpenCodeModels(
  executablePath: string,
  env: NodeJS.ProcessEnv,
): Promise<readonly RuntimeModel[]> {
  const discoveryRoot = await mkdtemp(join(tmpdir(), "pragma-opencode-discovery-"));
  try {
    const detected = await probeOpenCode(executablePath, env);
    const discoveryDataEnv = await prepareOpenCodeDataHome(env, discoveryRoot);
    const discovery = await prepareOpenCodeConfiguration({
      env: discoveryDataEnv,
      workspace: discoveryRoot,
      sessionDir: discoveryRoot,
      major: detected.major,
    });
    const nativeProcess = await startOpenCodeProcess({
      executablePath,
      env: discovery.env,
      cwd: discoveryRoot,
      ...detected,
    });
    const client = connectOpenCode(nativeProcess, discoveryRoot);
    try {
      const models = (await client.listModels()).map(mapOpenCodeModel);
      if (models.length === 0) throw new Error("OpenCode model discovery returned no models.");
      return models;
    } finally {
      await client.close();
    }
  } finally {
    await rm(discoveryRoot, { recursive: true, force: true });
  }
}

function modelCatalogCacheKey(options: OpenCodeModelDiscoveryOptions): string {
  return createHash("sha256")
    .update("pragma.opencode-model-catalog/v1\0")
    .update(options.executablePath)
    .update("\0")
    .update(options.modelCatalogCacheRoot ?? "default")
    .update("\0")
    .update(
      JSON.stringify(
        Object.entries(options.env).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}

function notifyModelCatalogUpdated(listener: (() => void) | undefined): void {
  try {
    listener?.();
  } catch {
    // Host invalidation is best-effort and must not fail a successful refresh.
  }
}
