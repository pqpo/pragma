import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, PragmaPaths } from "../storage/pragma-paths.ts";
import type { RuntimeModel } from "./runtime-adapter.ts";

const MODEL_CATALOG_CACHE_SCHEMA = "pragma.runtime-model-catalog/v1" as const;
const MODEL_CATALOG_CACHE_FILE_LIMIT = 16;

export interface RuntimeModelCatalogCacheOptions {
  readonly runtimeId: string;
  /** Stable discovery inputs. Secrets are hashed before they are written to disk. */
  readonly cacheKey: string;
  /** Usually `PragmaPaths.cacheRoot()`. Defaults to the current Pragma cache root. */
  readonly cacheRoot?: string | undefined;
}

interface RuntimeModelCatalogCacheRecord {
  readonly schemaVersion: typeof MODEL_CATALOG_CACHE_SCHEMA;
  readonly runtimeId: string;
  readonly cacheKey: string;
  readonly savedAt: number;
  readonly models: readonly unknown[];
}

/**
 * Read a rebuildable model catalog cache. Cache failures are deliberately treated as misses:
 * the live Runtime probe remains authoritative and the cache must never prevent startup.
 */
export async function readRuntimeModelCatalogCache<T>(
  options: RuntimeModelCatalogCacheOptions,
  parseModels: (value: unknown) => readonly T[] | undefined,
): Promise<readonly T[] | undefined> {
  try {
    const record = JSON.parse(
      await readFile(runtimeModelCatalogCachePath(options), "utf8"),
    ) as unknown;
    if (!isRuntimeModelCatalogCacheRecord(record, options)) {
      return undefined;
    }
    const models = parseModels(record.models);
    return models === undefined || models.length === 0 ? undefined : models;
  } catch {
    return undefined;
  }
}

/** Write a rebuildable catalog cache without making it part of the Runtime's authority. */
export async function writeRuntimeModelCatalogCache<T>(
  options: RuntimeModelCatalogCacheOptions,
  models: readonly T[],
): Promise<void> {
  if (models.length === 0) return;

  const record: RuntimeModelCatalogCacheRecord = {
    schemaVersion: MODEL_CATALOG_CACHE_SCHEMA,
    runtimeId: options.runtimeId,
    cacheKey: runtimeModelCatalogCacheFingerprint(options.cacheKey),
    savedAt: Date.now(),
    models,
  };
  let temporary: string | undefined;

  try {
    const file = runtimeModelCatalogCachePath(options);
    temporary = `${file}.tmp-${randomUUID()}`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, file);
    await pruneRuntimeModelCatalogCache(dirname(file), file);
  } catch {
    // A model catalog cache is disposable. A read-only or full cache directory must not
    // turn a successful live Runtime probe into a failed Runtime startup.
    if (temporary !== undefined) {
      try {
        await unlink(temporary);
      } catch {
        // The temporary file is disposable too; cleanup failures are harmless.
      }
    }
  }
}

async function pruneRuntimeModelCatalogCache(
  directory: string,
  currentFile: string,
): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            /^[a-f0-9]{64}\.json$/.test(entry.name) &&
            join(directory, entry.name) !== currentFile,
        )
        .map(async (entry) => {
          const file = join(directory, entry.name);
          const metadata = await stat(file).catch(() => undefined);
          return metadata === undefined ? undefined : { file, modifiedAt: metadata.mtimeMs };
        }),
    );
    const stale = candidates
      .filter(
        (candidate): candidate is { file: string; modifiedAt: number } => candidate !== undefined,
      )
      .toSorted((left, right) => left.modifiedAt - right.modifiedAt)
      .slice(0, Math.max(0, candidates.length - (MODEL_CATALOG_CACHE_FILE_LIMIT - 1)));
    await Promise.all(stale.map(({ file }) => unlink(file).catch(() => undefined)));
  } catch {
    // Cache cleanup is best-effort and must never affect a successful live probe.
  }
}

export function parseRuntimeModelCatalogModels(
  value: unknown,
): readonly RuntimeModel[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRuntimeModel)) {
    return undefined;
  }
  return value;
}

export function runtimeModelCatalogCachePath(options: RuntimeModelCatalogCacheOptions): string {
  const cacheRoot = options.cacheRoot ?? new PragmaPaths().cacheRoot();
  return join(
    cacheRoot,
    "runtimes",
    "model-catalog",
    encodePragmaPathSegment(options.runtimeId),
    `${runtimeModelCatalogCacheFingerprint(options.cacheKey)}.json`,
  );
}

/** Give each live discovery exactly one retry opportunity. */
export async function retryRuntimeModelDiscovery<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (firstError) {
    try {
      return await operation();
    } catch {
      throw firstError;
    }
  }
}

function runtimeModelCatalogCacheFingerprint(cacheKey: string): string {
  return createHash("sha256")
    .update("pragma.runtime-model-catalog-key/v1\0")
    .update(cacheKey)
    .digest("hex");
}

function isRuntimeModelCatalogCacheRecord(
  value: unknown,
  options: RuntimeModelCatalogCacheOptions,
): value is RuntimeModelCatalogCacheRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record["schemaVersion"] === MODEL_CATALOG_CACHE_SCHEMA &&
    record["runtimeId"] === options.runtimeId &&
    record["cacheKey"] === runtimeModelCatalogCacheFingerprint(options.cacheKey) &&
    typeof record["savedAt"] === "number" &&
    Number.isFinite(record["savedAt"]) &&
    Array.isArray(record["models"])
  );
}

function isRuntimeModel(value: unknown): value is RuntimeModel {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  const provider = model["provider"];
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
    return false;
  }
  const providerRecord = provider as Record<string, unknown>;
  if (
    typeof model["id"] !== "string" ||
    typeof model["displayName"] !== "string" ||
    (model["default"] !== undefined && typeof model["default"] !== "boolean") ||
    (providerRecord["kind"] !== "runtime-managed" && providerRecord["kind"] !== "registered") ||
    typeof providerRecord["id"] !== "string" ||
    typeof providerRecord["displayName"] !== "string"
  ) {
    return false;
  }
  if (
    model["inputModalities"] !== undefined &&
    (!Array.isArray(model["inputModalities"]) ||
      !model["inputModalities"].every((item) => typeof item === "string"))
  ) {
    return false;
  }
  const thinking = model["thinking"];
  if (thinking === undefined) return true;
  if (thinking === null || typeof thinking !== "object" || Array.isArray(thinking)) return false;
  const thinkingRecord = thinking as Record<string, unknown>;
  const supportedLevels = thinkingRecord["supportedLevels"];
  return (
    Array.isArray(supportedLevels) &&
    supportedLevels.length > 0 &&
    supportedLevels.every((level) => {
      if (level === null || typeof level !== "object" || Array.isArray(level)) return false;
      const record = level as Record<string, unknown>;
      return typeof record["value"] === "string" && typeof record["label"] === "string";
    }) &&
    (thinkingRecord["defaultLevel"] === undefined ||
      typeof thinkingRecord["defaultLevel"] === "string")
  );
}
