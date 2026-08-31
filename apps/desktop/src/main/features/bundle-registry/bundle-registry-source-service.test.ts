import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AddDesktopBundleRegistrySourceSchema,
  DesktopBundleRegistryRemoteSchema,
} from "../../../shared/contracts/index.ts";
import { createDesktopBundleRegistrySourceService } from "./bundle-registry-source-service.ts";

const temporaryRoots: string[] = [];

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
});
