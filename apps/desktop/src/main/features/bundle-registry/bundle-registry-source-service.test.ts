import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  AddDesktopBundleRegistrySourceSchema,
  DesktopBundleRegistrySnapshotSchema,
  DesktopBundleRegistryRemoteSchema,
  DownloadDesktopSquareBundleSchema,
} from "../../../shared/contracts/index.ts";
import { createDesktopBundleRegistrySourceService } from "./bundle-registry-source-service.ts";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Desktop Bundle Registry sources", () => {
  it("persists an official source toggle without trusting persisted official identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-registry-"));
    temporaryRoots.push(root);
    const options = {
      sourcesPath: join(root, "data", "sources.json"),
      cacheRoot: join(root, "cache"),
      officialSource: {
        name: "Pragma Official",
        remote: "https://github.com/example/pragma-registry.git",
      },
    } as const;
    const service = createDesktopBundleRegistrySourceService(options);
    const [official] = await service.listSources();
    expect(official).toMatchObject({ official: true, enabled: true });

    await service.updateSource({ sourceId: official!.id, enabled: false });
    const restarted = createDesktopBundleRegistrySourceService(options);
    await expect(restarted.listSources()).resolves.toEqual([
      expect.objectContaining({ official: true, enabled: false }),
    ]);
    await expect(restarted.removeSource(official!.id)).rejects.toThrow(/cannot be removed/u);

    const withoutOfficial = createDesktopBundleRegistrySourceService({
      sourcesPath: options.sourcesPath,
      cacheRoot: options.cacheRoot,
    });
    await expect(withoutOfficial.listSources()).resolves.toEqual([]);
  });

  it("accepts system-Git remotes but rejects embedded HTTPS credentials", () => {
    expect(
      DesktopBundleRegistryRemoteSchema.safeParse("git@gitlab.example:team/registry.git").success,
    ).toBe(true);
    expect(
      DesktopBundleRegistryRemoteSchema.safeParse("https://token@git.example/registry.git").success,
    ).toBe(false);
    expect(
      DesktopBundleRegistryRemoteSchema.safeParse("ssh://user:password@git.example/registry.git")
        .success,
    ).toBe(false);
    expect(
      AddDesktopBundleRegistrySourceSchema.safeParse({
        name: "Unsafe",
        remote: "https://git.example/team/registry.git",
        ref: "--upload-pack=malicious",
      }).success,
    ).toBe(false);
  });

  it("invalidates the generated Catalog snapshot and keys downloads by source, kind, item, and version", () => {
    expect(
      DesktopBundleRegistrySnapshotSchema.safeParse({
        schemaVersion: "pragma.desktop-bundle-registry-snapshot/v1",
        commit: "a".repeat(40),
        syncedAt: "2026-08-31T00:00:00.000Z",
        manifest: {},
        catalog: {},
        packages: [],
      }).success,
    ).toBe(false);
    expect(
      DownloadDesktopSquareBundleSchema.parse({
        sourceId: "11111111-1111-4111-8111-111111111111",
        kind: "expert-team",
        itemId: "product-team",
        version: "1.0.0",
      }),
    ).toMatchObject({ kind: "expert-team", itemId: "product-team" });
  });

  it("discovers configs without decoding Bundles and falls back to a stale snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-source-sync-"));
    temporaryRoots.push(root);
    const remote = join(root, "remote");
    await mkdir(join(remote, "experts/general/reviewer/versions/1.0.0"), { recursive: true });
    await writeFile(join(remote, "pragma-source.yaml"), sourceManifest(), "utf8");
    await writeFile(
      join(remote, "experts/general/reviewer/config.yaml"),
      sourceItemConfig(),
      "utf8",
    );
    await writeFile(
      join(remote, "experts/general/reviewer/versions/1.0.0/bundle.pragma"),
      "intentionally-not-a-bundle",
    );
    await execFileAsync("git", ["-C", remote, "init"]);
    await commitAll(remote, "Valid source");

    const previous = [
      process.env.GIT_CONFIG_COUNT,
      process.env.GIT_CONFIG_KEY_0,
      process.env.GIT_CONFIG_VALUE_0,
    ] as const;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "url.file:///.insteadOf";
    process.env.GIT_CONFIG_VALUE_0 = "https://pragma-source.test/";
    try {
      const service = createDesktopBundleRegistrySourceService({
        sourcesPath: join(root, "data/sources.json"),
        cacheRoot: join(root, "cache"),
      });
      const status = await service.addSource({
        name: "Local Source",
        remote: `https://pragma-source.test${remote}`,
      });
      expect(status).toMatchObject({ status: "ready", itemCount: 1 });
      await expect(service.getCatalog()).resolves.toMatchObject({
        items: [expect.objectContaining({ id: "reviewer", kind: "expert" })],
      });
      await expect(
        service.downloadBundle({
          sourceId: status.id,
          kind: "expert",
          itemId: "reviewer",
          version: "1.0.0",
        }),
      ).rejects.toThrow();

      await writeFile(
        join(remote, "experts/general/reviewer/config.yaml"),
        sourceItemConfig().replace("id: reviewer", "id: wrong-id"),
        "utf8",
      );
      await commitAll(remote, "Invalid source");
      await expect(service.refreshSource(status.id)).resolves.toMatchObject({
        status: "stale",
        itemCount: 1,
      });
      await expect(service.getCatalog()).resolves.toMatchObject({
        items: [expect.objectContaining({ id: "reviewer" })],
      });

      await writeFile(
        join(remote, "experts/general/reviewer/config.yaml"),
        sourceItemConfig(),
        "utf8",
      );
      await symlink("pragma-source.yaml", join(remote, "source-link.yaml"));
      await commitAll(remote, "Unsafe source link");
      await expect(service.refreshSource(status.id)).resolves.toMatchObject({
        status: "stale",
        errorMessage: expect.stringMatching(/symlinks and submodules/u),
      });
    } finally {
      restoreEnvironment("GIT_CONFIG_COUNT", previous[0]);
      restoreEnvironment("GIT_CONFIG_KEY_0", previous[1]);
      restoreEnvironment("GIT_CONFIG_VALUE_0", previous[2]);
    }
  });
});

async function commitAll(repository: string, message: string): Promise<void> {
  await execFileAsync("git", ["-C", repository, "add", "."]);
  await execFileAsync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Pragma Test",
    "-c",
    "user.email=test@pragma.invalid",
    "commit",
    "-m",
    message,
  ]);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function sourceManifest(): string {
  return `schemaVersion: pragma.bundle-source/v1
id: local-source
name:
  default: Local Source
maxBundleBytes: 1048576
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

function sourceItemConfig(): string {
  return `schemaVersion: pragma.bundle-source-item/v1
id: reviewer
rootRef: expert:1234567890abcdef
name:
  default: Reviewer
summary:
  default: Reviews code
description:
  default: Reviews code carefully.
author:
  name: Pragma
license: MIT
tags:
  - review
latestVersion: 1.0.0
createdAt: 2026-08-31T00:00:00.000Z
updatedAt: 2026-08-31T00:00:00.000Z
`;
}
