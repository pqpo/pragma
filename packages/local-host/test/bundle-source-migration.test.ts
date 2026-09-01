import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { migrateBundleRegistryV1, validateBundleSourceDirectory } from "../src/index.ts";
import { createExpertBundle } from "./bundle-source-fixture.ts";

describe("Bundle Registry v1 migration", () => {
  it("backs up the generated Registry and migrates every version", async () => {
    const root = await legacyRegistryFixture();
    const result = await migrateBundleRegistryV1(root);

    expect(result).toMatchObject({
      status: "migrated",
      sourceId: "legacy-source",
      itemCount: 1,
      versionCount: 2,
    });
    await expect(
      stat(join(root, ".pragma-registry-v1-backup/pragma-registry.yaml")),
    ).resolves.toBeDefined();
    await expect(
      stat(join(root, "experts/general/reviewer/versions/1.1.0/bundle.pragma")),
    ).resolves.toBeDefined();
    await expect(validateBundleSourceDirectory(root)).resolves.toMatchObject({
      itemCount: 1,
      versionCount: 2,
    });
    await expect(migrateBundleRegistryV1(root)).resolves.toMatchObject({
      status: "already-current",
      sourceId: "legacy-source",
    });
  });

  it("fails before changing the Registry when media cannot be mapped", async () => {
    const root = await legacyRegistryFixture(true);
    await expect(migrateBundleRegistryV1(root)).rejects.toThrow(/cannot be mapped losslessly/u);
    await expect(stat(join(root, "pragma-registry.yaml"))).resolves.toBeDefined();
    await expect(stat(join(root, ".pragma-registry-v1-backup"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resumes an interrupted installation from its stable journal", async () => {
    const root = await legacyRegistryFixture();
    const staged = join(root, ".pragma-source-migration-staging");
    await mkdir(join(staged, "experts/general/reviewer/versions/1.0.0"), { recursive: true });
    await writeFile(join(staged, "pragma-source.yaml"), sourceManifest(), "utf8");
    await writeFile(join(staged, "experts/general/reviewer/config.yaml"), itemConfig(), "utf8");
    await writeFile(
      join(staged, "experts/general/reviewer/versions/1.0.0/bundle.pragma"),
      "bundle-one",
    );
    await writeFile(
      join(staged, "bundle-source-migration-report.json"),
      `${JSON.stringify({ sourceId: "legacy-source", itemCount: 1, versionCount: 1 })}\n`,
    );
    const backup = join(root, ".pragma-registry-v1-backup");
    await mkdir(backup);
    for (const name of ["pragma-registry.yaml", "catalog", "objects", "packages"]) {
      try {
        await rename(join(root, name), join(backup, name));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    await writeFile(
      join(root, ".pragma-source-migration-v1.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.bundle-source-migration-journal/v1",
        operationId: "11111111-1111-4111-8111-111111111111",
        phase: "backed-up",
      })}\n`,
    );

    await expect(migrateBundleRegistryV1(root)).resolves.toMatchObject({ status: "migrated" });
    expect(await readFile(join(root, "pragma-source.yaml"), "utf8")).toContain(
      "pragma.bundle-source/v1",
    );
  });

  it("rejects a future Bundle Source protocol instead of downgrading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-source-future-"));
    await writeFile(
      join(root, "pragma-source.yaml"),
      sourceManifest().replace("pragma.bundle-source/v1", "pragma.bundle-source/v2"),
      "utf8",
    );
    await expect(migrateBundleRegistryV1(root)).rejects.toThrow();
  });
});

async function legacyRegistryFixture(withScreenshot = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-registry-migration-"));
  await mkdir(join(root, "packages/general/reviewer"), { recursive: true });
  await mkdir(join(root, "objects"), { recursive: true });
  await mkdir(join(root, "catalog"), { recursive: true });
  await writeFile(join(root, "pragma-registry.yaml"), legacyManifest(), "utf8");
  await writeFile(join(root, "packages/general/reviewer/README.md"), "# Reviewer\n", "utf8");
  await writeFile(
    join(root, "packages/general/reviewer/package.yaml"),
    legacyPackage(withScreenshot),
    "utf8",
  );
  await createExpertBundle(root, join(root, "objects/one.pragma"));
  await copyFile(join(root, "objects/one.pragma"), join(root, "objects/two.pragma"));
  return root;
}

function legacyManifest(): string {
  return `schemaVersion: pragma.bundle-registry/v1
id: legacy-source
name:
  default: Legacy Source
description:
  default: Legacy bundles
maxBundleBytes: 1048576
categories:
  - id: general
    name:
      default: General
    order: 0
`;
}

function legacyPackage(withScreenshot: boolean): string {
  return `schemaVersion: pragma.bundle-registry-package/v1
id: reviewer
name:
  default: Reviewer
summary:
  default: Reviews code
publisher:
  name: Pragma
license: MIT
primaryCategory: general
tags:
  - review
readme: packages/general/reviewer/README.md
media:
  screenshots:${withScreenshot ? "\n    - path: media/review.png" : " []"}
channels:
  stable: 1.1.0
versions:
  - version: 1.0.0
    releasedAt: 2026-01-01T00:00:00.000Z
    bundle:
      path: objects/one.pragma
      root:
        ref: expert:1xddvess309a6gme
        kind: Expert
  - version: 1.1.0
    releasedAt: 2026-02-01T00:00:00.000Z
    bundle:
      path: objects/two.pragma
      root:
        ref: expert:1xddvess309a6gme
        kind: Expert
`;
}

function sourceManifest(): string {
  return `schemaVersion: pragma.bundle-source/v1
id: legacy-source
name:
  default: Legacy Source
sections:
  expert:
    categories: &categories
      - id: general
        name:
          default: General
  expert-team:
    categories: *categories
  flow:
    categories: *categories
`;
}

function itemConfig(): string {
  return `schemaVersion: pragma.bundle-source-item/v1
id: reviewer
rootRef: expert:1xddvess309a6gme
name:
  default: Reviewer
summary:
  default: Reviews code
description:
  default: Reviews code
author:
  name: Pragma
license: MIT
tags: []
latestVersion: 1.0.0
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
`;
}
