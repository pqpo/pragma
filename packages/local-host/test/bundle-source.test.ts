import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import {
  addBundleSourceVersion,
  initializeBundleSource,
  readBundleSourceManifest,
  upgradeBundleSource,
} from "../src/index.ts";
import { createExpertBundle } from "./bundle-source-fixture.ts";

const execFileAsync = promisify(execFile);

describe("Bundle Source repository", () => {
  it("initializes a readable source with type-specific default categories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-source-"));
    const result = await initializeBundleSource({
      directory: root,
      id: "team-source",
      name: "Team Source",
    });

    expect(result.sourceId).toBe("team-source");
    expect(result.directories).toContain("experts/software-development");
    expect(result.directories).toContain("knowledge-bases/general");
    await expect(stat(join(root, "expert-teams/product-design"))).resolves.toMatchObject({});
    await expect(readBundleSourceManifest(root)).resolves.toMatchObject({
      schemaVersion: "pragma.bundle-source/v2",
      id: "team-source",
    });
    const raw = parse(await readFile(join(root, "pragma-source.yaml"), "utf8"));
    expect(raw.sections.expert.categories).toHaveLength(7);
  });

  it("does not replace an existing source", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-source-existing-"));
    await initializeBundleSource({ directory: root, id: "first", name: "First" });
    await expect(
      initializeBundleSource({ directory: root, id: "second", name: "Second" }),
    ).rejects.toThrow(/already exists/u);
  });

  it("adds immutable versions without changing Git history", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-source-add-"));
    await initializeBundleSource({ directory: root, id: "community", name: "Community" });
    await execFileAsync("git", ["-C", root, "init"]);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "user.name=Pragma Test",
      "-c",
      "user.email=test@pragma.invalid",
      "commit",
      "-m",
      "Initialize source",
    ]);
    const { stdout: headBefore } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    const bundlePath = await createExpertBundle(root);
    const input = {
      directory: root,
      bundlePath,
      kind: "expert" as const,
      categoryId: "software-development",
      itemId: "reviewer",
      rootRef: "expert:1xddvess309a6gme",
      name: "Reviewer",
      summary: "Reviews code",
      description: "Reviews code carefully.",
      authorName: "Pragma",
      license: "MIT",
      tags: ["review"],
    };

    await expect(
      addBundleSourceVersion({
        ...input,
        itemId: "invalid-reviewer",
        authorName: "",
        version: "1.0.0",
      }),
    ).rejects.toThrow();
    await expect(
      stat(join(root, "experts/software-development/invalid-reviewer")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await addBundleSourceVersion({ ...input, version: "1.0.0" });
    await expect(addBundleSourceVersion({ ...input, version: "1.0.0" })).rejects.toThrow(
      /already exists/u,
    );
    await addBundleSourceVersion({ ...input, version: "1.1.0" });

    const config = parse(
      await readFile(join(root, "experts/software-development/reviewer/config.yaml"), "utf8"),
    );
    expect(config.latestVersion).toBe("1.1.0");
    const { stdout: headAfter } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    expect(headAfter).toBe(headBefore);
  });

  it("upgrades v1 sources with backups and resumes a prepared journal idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-source-upgrade-"));
    await execFileAsync("git", ["-C", root, "init"]);
    const categories = [{ id: "general", name: { default: "General" }, order: 0 }];
    await writeFile(
      join(root, "pragma-source.yaml"),
      stringify({
        schemaVersion: "pragma.bundle-source/v1",
        id: "legacy",
        name: { default: "Legacy" },
        sections: {
          expert: { categories },
          "expert-team": { categories },
          flow: { categories },
        },
      }),
    );
    const configDirectory = join(root, "experts/general/reviewer");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "config.yaml"),
      stringify({
        schemaVersion: "pragma.bundle-source-item/v1",
        id: "reviewer",
        rootRef: "expert:1234567890abcdef",
        name: { default: "Reviewer" },
        summary: { default: "Reviews code" },
        description: { default: "Reviews code carefully" },
        author: { name: "Pragma" },
        license: "MIT",
        latestVersion: "1.0.0",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }),
    );

    const upgraded = await upgradeBundleSource(root);
    expect(upgraded).toMatchObject({ upgraded: true, itemCount: 1 });
    await expect(
      stat(join(root, ".pragma-source-v1-backup/pragma-source.yaml")),
    ).resolves.toBeDefined();
    await expect(stat(join(root, "knowledge-bases/general"))).resolves.toBeDefined();
    expect(parse(await readFile(join(configDirectory, "config.yaml"), "utf8"))).toMatchObject({
      schemaVersion: "pragma.bundle-source-item/v2",
    });

    const journalPath = join(root, ".pragma-source-upgrade.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    await writeFile(
      join(root, "pragma-source.yaml"),
      await readFile(join(root, ".pragma-source-v1-backup/pragma-source.yaml"), "utf8"),
    );
    await writeFile(journalPath, `${JSON.stringify({ ...journal, status: "prepared" })}\n`);
    await expect(upgradeBundleSource(root)).resolves.toMatchObject({
      upgraded: true,
      itemCount: 1,
    });

    await writeFile(journalPath, `${JSON.stringify({ ...journal, status: "prepared" })}\n`);
    await expect(upgradeBundleSource(root)).resolves.toMatchObject({
      upgraded: true,
      itemCount: 1,
    });
    await expect(upgradeBundleSource(root)).resolves.toMatchObject({
      upgraded: false,
      itemCount: 1,
    });
  });

  it("refuses to reuse a stale v1 upgrade backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-source-stale-backup-"));
    await execFileAsync("git", ["-C", root, "init"]);
    const categories = [{ id: "general", name: { default: "General" }, order: 0 }];
    await writeFile(
      join(root, "pragma-source.yaml"),
      stringify({
        schemaVersion: "pragma.bundle-source/v1",
        id: "legacy",
        name: { default: "Legacy" },
        sections: {
          expert: { categories },
          "expert-team": { categories },
          flow: { categories },
        },
      }),
    );
    await mkdir(join(root, ".pragma-source-v1-backup"), { recursive: true });
    await writeFile(join(root, ".pragma-source-v1-backup/pragma-source.yaml"), "stale\n");

    await expect(upgradeBundleSource(root)).rejects.toThrow(
      "Bundle Source upgrade backup does not match its source",
    );
  });
});
