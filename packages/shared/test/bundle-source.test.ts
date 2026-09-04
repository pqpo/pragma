import { describe, expect, it } from "vitest";

import {
  BundleSourceItemSchema,
  BundleSourceManifestSchema,
  bundleSourceItemDirectory,
  parseBundleSourceItem,
  parseBundleSourceManifest,
  parseBundleSourceRepositoryEntry,
} from "../src/index.ts";

describe("Bundle Source protocol", () => {
  it("defines type-specific governed categories", () => {
    expect(
      BundleSourceManifestSchema.parse({
        schemaVersion: "pragma.bundle-source/v2",
        id: "official",
        name: { default: "Pragma Official", translations: { "zh-Hans": "Pragma 官方" } },
        sections: {
          expert: { categories: [{ id: "general", name: { default: "General" } }] },
          "expert-team": {
            categories: [{ id: "product-design", name: { default: "Product Design" } }],
          },
          flow: { categories: [{ id: "content", name: { default: "Content" } }] },
          "knowledge-base": { categories: [{ id: "general", name: { default: "General" } }] },
        },
      }),
    ).toMatchObject({ id: "official", maxBundleBytes: 100 * 1024 * 1024 });
  });

  it("rejects duplicate categories and invalid item timestamps", () => {
    expect(
      BundleSourceManifestSchema.safeParse({
        schemaVersion: "pragma.bundle-source/v2",
        id: "invalid",
        name: { default: "Invalid" },
        sections: {
          expert: {
            categories: [
              { id: "general", name: { default: "General" } },
              { id: "general", name: { default: "Duplicate" } },
            ],
          },
          "expert-team": { categories: [{ id: "general", name: { default: "General" } }] },
          flow: { categories: [{ id: "general", name: { default: "General" } }] },
          "knowledge-base": { categories: [{ id: "general", name: { default: "General" } }] },
        },
      }).success,
    ).toBe(false);
    expect(
      BundleSourceManifestSchema.safeParse({
        schemaVersion: "pragma.bundle-source/v3",
        id: "future",
        name: { default: "Future" },
        sections: {
          expert: { categories: [{ id: "general", name: { default: "General" } }] },
          "expert-team": { categories: [{ id: "general", name: { default: "General" } }] },
          flow: { categories: [{ id: "general", name: { default: "General" } }] },
        },
      }).success,
    ).toBe(false);
    expect(
      BundleSourceItemSchema.safeParse({
        schemaVersion: "pragma.bundle-source-item/v2",
        id: "reviewer",
        rootRef: "expert:1234567890abcdef",
        name: { default: "Reviewer" },
        summary: { default: "Reviews code." },
        description: { default: "Reviews code carefully." },
        author: { name: "Pragma" },
        license: "MIT",
        latestVersion: "1.0.0",
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("maps canonical repository paths without allowing extra item files", () => {
    expect(
      bundleSourceItemDirectory({
        kind: "expert-team",
        categoryId: "product-design",
        itemId: "review-team",
      }),
    ).toBe("expert-teams/product-design/review-team");
    expect(
      parseBundleSourceRepositoryEntry(
        "experts/software-development/code-reviewer/versions/1.2.0/bundle.pragma",
      ),
    ).toEqual({
      kind: "bundle",
      sourceKind: "expert",
      categoryId: "software-development",
      itemId: "code-reviewer",
      version: "1.2.0",
    });
    expect(parseBundleSourceRepositoryEntry("experts/general/reviewer/README.md")).toBeUndefined();
    expect(
      parseBundleSourceRepositoryEntry(
        "knowledge-bases/research/handbook/versions/2.0.0/bundle.pragma",
      ),
    ).toMatchObject({ kind: "bundle", sourceKind: "knowledge-base", itemId: "handbook" });
    expect(
      parseBundleSourceRepositoryEntry(
        "experts/general/reviewer/versions/../../outside/bundle.pragma",
      ),
    ).toBeUndefined();
  });

  it("upgrades v1 manifests and items without changing existing entries", () => {
    const categories = [{ id: "general", name: { default: "General" } }];
    const manifest = parseBundleSourceManifest({
      schemaVersion: "pragma.bundle-source/v1",
      id: "official",
      name: { default: "Official" },
      sections: {
        expert: { categories },
        "expert-team": { categories },
        flow: { categories },
      },
    });
    expect(manifest.schemaVersion).toBe("pragma.bundle-source/v2");
    expect(manifest.sections["knowledge-base"].categories).toEqual(
      manifest.sections.expert.categories,
    );
    expect(
      parseBundleSourceItem({
        schemaVersion: "pragma.bundle-source-item/v1",
        id: "reviewer",
        rootRef: "expert:1234567890abcdef",
        name: { default: "Reviewer" },
        summary: { default: "Reviews code." },
        description: { default: "Reviews code carefully." },
        author: { name: "Pragma" },
        license: "MIT",
        latestVersion: "1.0.0",
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
      }),
    ).toMatchObject({ schemaVersion: "pragma.bundle-source-item/v2", id: "reviewer" });
  });
});
