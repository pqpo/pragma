import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  buildBundleRegistry,
  checkBundleRegistry,
  initializeBundleRegistry,
  initializeBundleRegistryPackage,
} from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Bundle Registry repository builder", () => {
  it("initializes deterministic empty catalogs and detects stale generated files without rewriting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-registry-"));
    temporaryRoots.push(root);
    await initializeBundleRegistry({ directory: root, id: "team-registry", name: "Team Registry" });

    await expect(checkBundleRegistry(root)).resolves.toMatchObject({
      registryId: "team-registry",
      packageCount: 0,
    });
    await expect(
      initializeBundleRegistry({ directory: root, id: "replacement", name: "Replacement" }),
    ).rejects.toThrow(/already exists/u);
    const catalogPath = join(root, "catalog", "index.json");
    const obsoletePath = join(root, "catalog", "obsolete.json");
    await writeFile(catalogPath, "{}\n", "utf8");
    await writeFile(obsoletePath, "{}\n", "utf8");
    await expect(checkBundleRegistry(root)).rejects.toThrow(/catalog is stale/u);
    await expect(readFile(catalogPath, "utf8")).resolves.toBe("{}\n");
    await expect(buildBundleRegistry(root)).resolves.toMatchObject({ packageCount: 0 });
    await expect(readFile(obsoletePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("scaffolds a package under its governed category", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-registry-package-"));
    temporaryRoots.push(root);
    await initializeBundleRegistry({ directory: root, id: "team-registry", name: "Team Registry" });
    const result = await initializeBundleRegistryPackage({
      directory: root,
      packageId: "review-assistant",
      categoryId: "development/coding",
      name: "Review Assistant",
      publisher: "Pragma Team",
    });

    const draft = parse(await readFile(result.packagePath, "utf8")) as Record<string, unknown>;
    expect(draft).toMatchObject({
      id: "review-assistant",
      primaryCategory: "development/coding",
      publisher: { name: "Pragma Team" },
      versions: [],
    });
    await expect(
      readFile(join(root, "packages/development/coding/review-assistant/README.md"), "utf8"),
    ).resolves.toContain("# Review Assistant");
  });
});
