import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  addBundleSourceVersion,
  initializeBundleSource,
  readBundleSourceManifest,
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
    await expect(stat(join(root, "expert-teams/product-design"))).resolves.toMatchObject({});
    await expect(readBundleSourceManifest(root)).resolves.toMatchObject({
      schemaVersion: "pragma.bundle-source/v1",
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
});
