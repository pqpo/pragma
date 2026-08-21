import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseRuntimeModelCatalogModels,
  readRuntimeModelCatalogCache,
  retryRuntimeModelDiscovery,
  runtimeModelCatalogCachePath,
  writeRuntimeModelCatalogCache,
} from "../src/runtime/model-catalog-cache.ts";

const cacheOptions = (cacheRoot: string) => ({
  runtimeId: "test-runtime",
  cacheKey: "executable=/tmp/test-runtime\0env=stable",
  cacheRoot,
});

const model = {
  id: "test-model",
  displayName: "Test model",
  provider: { kind: "runtime-managed" as const, id: "test", displayName: "Test" },
  inputModalities: ["text"],
};

describe("runtime model catalog cache", () => {
  it("round-trips a catalog through the rebuildable disk cache", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pragma-model-catalog-cache-"));
    const options = cacheOptions(cacheRoot);

    await writeRuntimeModelCatalogCache(options, [model]);

    await expect(
      readRuntimeModelCatalogCache(options, parseRuntimeModelCatalogModels),
    ).resolves.toEqual([model]);
    await expect(readFile(runtimeModelCatalogCachePath(options), "utf8")).resolves.toContain(
      "pragma.runtime-model-catalog/v1",
    );
  });

  it("ignores malformed or mismatched cache records", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pragma-model-catalog-cache-"));
    const options = cacheOptions(cacheRoot);
    await writeRuntimeModelCatalogCache(options, [model]);

    await expect(
      readRuntimeModelCatalogCache(
        { ...options, cacheKey: "different" },
        parseRuntimeModelCatalogModels,
      ),
    ).resolves.toBeUndefined();
  });

  it("retries exactly once and preserves the first error", async () => {
    let calls = 0;
    const firstError = new Error("first failure");

    await expect(
      retryRuntimeModelDiscovery(async () => {
        calls += 1;
        throw calls === 1 ? firstError : new Error("second failure");
      }),
    ).rejects.toBe(firstError);
    expect(calls).toBe(2);
  });
});
