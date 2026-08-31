import { describe, expect, it } from "vitest";

import {
  BundleRegistryCatalogIndexSchema,
  BundleRegistryManifestSchema,
  BundleRegistryRelativePathSchema,
} from "../src/index.ts";

describe("Bundle Registry protocol", () => {
  it("accepts governed two-level categories and localized metadata", () => {
    expect(
      BundleRegistryManifestSchema.parse({
        schemaVersion: "pragma.bundle-registry/v1",
        id: "official",
        name: { default: "Pragma Official", translations: { "zh-Hans": "Pragma 官方" } },
        categories: [
          { id: "development", name: { default: "Development" } },
          { id: "development/coding", name: { default: "Coding" } },
        ],
      }),
    ).toMatchObject({ id: "official", catalog: "catalog/index.json" });
  });

  it("rejects orphan categories and repository path traversal", () => {
    expect(() =>
      BundleRegistryManifestSchema.parse({
        schemaVersion: "pragma.bundle-registry/v1",
        id: "invalid",
        name: { default: "Invalid" },
        categories: [{ id: "development/coding", name: { default: "Coding" } }],
      }),
    ).toThrow(/Missing parent category/u);
    expect(BundleRegistryRelativePathSchema.safeParse("../private.pragma").success).toBe(false);
    expect(
      BundleRegistryRelativePathSchema.safeParse("objects/sha256/aa/value.pragma").success,
    ).toBe(true);
  });

  it("rejects duplicate or incomplete catalog shards", () => {
    const shard = {
      prefix: "a",
      path: "catalog/packages/a.json",
      sha256: "a".repeat(64),
      count: 1,
    };
    expect(
      BundleRegistryCatalogIndexSchema.safeParse({
        schemaVersion: "pragma.bundle-registry-catalog/v1",
        registryId: "official",
        packageCount: 1,
        packageShards: [shard, shard],
        categoryIndexes: [],
      }).success,
    ).toBe(false);
  });
});
