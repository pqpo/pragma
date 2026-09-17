import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { decodePragmaBundle, formatPragmaYaml, loadPragmaProject } from "@pragma/interpreter";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";

import {
  AddDesktopBundleRegistrySourceSchema,
  DesktopBundleRegistrySnapshotSchema,
  DesktopBundleRegistryRemoteSchema,
  DesktopSquareBundleDownloadSchema,
  DownloadDesktopSquareBundleSchema,
  UpdateDesktopBundleRegistrySourceSchema,
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
  it("migrates the historical v1 ref to the v2 branch with a backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-registry-migration-"));
    temporaryRoots.push(root);
    const sourcesPath = join(root, "data", "sources.json");
    await mkdir(join(root, "data"), { recursive: true });
    await copyFile(
      join(import.meta.dirname, "test/fixtures/bundle-registry-sources-v1.json"),
      sourcesPath,
    );
    const service = createDesktopBundleRegistrySourceService({
      sourcesPath,
      cacheRoot: join(root, "cache"),
    });

    await expect(service.listSources()).resolves.toEqual([
      expect.objectContaining({ branch: "release", name: "Historical source" }),
    ]);
    await expect(readFile(sourcesPath, "utf8")).resolves.toContain(
      '"schemaVersion": "pragma.desktop-bundle-registry-sources/v2"',
    );
    await expect(readFile(`${sourcesPath}.v1.backup`, "utf8")).resolves.toContain(
      '"ref": "release"',
    );
  });

  it("recovers a completed migration journal and rejects future source settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-registry-recovery-"));
    temporaryRoots.push(root);
    const sourcesPath = join(root, "data", "sources.json");
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(
      sourcesPath,
      `${JSON.stringify({ schemaVersion: "pragma.desktop-bundle-registry-sources/v2", sources: [] })}\n`,
    );
    await writeFile(`${sourcesPath}.v1.backup`, "historical settings\n");
    await writeFile(
      `${sourcesPath}.migration.json`,
      `${JSON.stringify({
        schemaVersion: "pragma.desktop-bundle-registry-sources-migration/v1",
        sourceVersion: "pragma.desktop-bundle-registry-sources/v1",
        targetVersion: "pragma.desktop-bundle-registry-sources/v2",
        backupPath: `${sourcesPath}.v1.backup`,
      })}\n`,
    );
    const service = createDesktopBundleRegistrySourceService({
      sourcesPath,
      cacheRoot: join(root, "cache"),
    });
    await expect(service.listSources()).resolves.toEqual([]);
    await expect(readFile(`${sourcesPath}.migration.json`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(
      sourcesPath,
      `${JSON.stringify({ schemaVersion: "pragma.desktop-bundle-registry-sources/v3", sources: [] })}\n`,
    );
    await expect(service.listSources()).rejects.toThrow(/configuration is unreadable/u);
  });

  it("fails closed when the source settings migration journal is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-registry-journal-"));
    temporaryRoots.push(root);
    const sourcesPath = join(root, "data", "sources.json");
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(
      sourcesPath,
      `${JSON.stringify({ schemaVersion: "pragma.desktop-bundle-registry-sources/v2", sources: [] })}\n`,
    );
    await writeFile(`${sourcesPath}.migration.json`, '{"status":"prepared"}\n');
    const service = createDesktopBundleRegistrySourceService({
      sourcesPath,
      cacheRoot: join(root, "cache"),
    });

    await expect(service.listSources()).rejects.toThrow(/configuration is unreadable/u);
    await expect(readFile(`${sourcesPath}.migration.json`, "utf8")).resolves.toContain(
      '"status":"prepared"',
    );
  });

  it("persists an official source toggle and allows the built-in source to be dismissed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-registry-"));
    temporaryRoots.push(root);
    const options = {
      sourcesPath: join(root, "data", "sources.json"),
      cacheRoot: join(root, "cache"),
      officialSource: {
        name: "官方源",
        remote: "git@github.com:pqpo/awesome-pragma.git",
      },
    } as const;
    const service = createDesktopBundleRegistrySourceService(options);
    const [official] = await service.listSources();
    expect(official).toMatchObject({
      name: "官方源",
      remote: "git@github.com:pqpo/awesome-pragma.git",
      official: true,
      enabled: true,
    });

    await service.updateSource({ sourceId: official!.id, enabled: false });
    const restarted = createDesktopBundleRegistrySourceService(options);
    await expect(restarted.listSources()).resolves.toEqual([
      expect.objectContaining({ official: true, enabled: false }),
    ]);
    await expect(restarted.removeSource(official!.id)).resolves.toBeUndefined();
    const afterRemoval = createDesktopBundleRegistrySourceService(options);
    await expect(afterRemoval.listSources()).resolves.toEqual([]);

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
        branch: "--upload-pack=malicious",
      }).success,
    ).toBe(false);
    expect(
      UpdateDesktopBundleRegistrySourceSchema.safeParse({
        sourceId: "11111111-1111-4111-8111-111111111111",
        remote: "git@gitlab.example:team/updated-registry.git",
      }).success,
    ).toBe(true);
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
    expect(
      DesktopSquareBundleDownloadSchema.parse({
        path: "/tmp/handbook.pragma",
        rootRef: "context-store:kqh4nx7rx26mb3e7",
        sha256: "a".repeat(64),
        cached: false,
      }),
    ).toMatchObject({ rootRef: "context-store:kqh4nx7rx26mb3e7" });
  });

  it("configures an empty repository and discovers content after its first commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-empty-source-"));
    temporaryRoots.push(root);
    const remote = join(root, "remote");
    await mkdir(remote, { recursive: true });
    await execFileAsync("git", ["-C", remote, "init"]);

    const previous = [
      process.env.GIT_CONFIG_COUNT,
      process.env.GIT_CONFIG_KEY_0,
      process.env.GIT_CONFIG_VALUE_0,
    ] as const;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "url.file:///.insteadOf";
    process.env.GIT_CONFIG_VALUE_0 = "https://pragma-empty-source.test/";
    try {
      const options = {
        sourcesPath: join(root, "data/sources.json"),
        cacheRoot: join(root, "cache"),
      } as const;
      const service = createDesktopBundleRegistrySourceService(options);
      const status = await service.addSource({
        name: "Empty Source",
        remote: `https://pragma-empty-source.test${remote}`,
      });
      expect(status).toMatchObject({ status: "ready", itemCount: 0 });
      expect(status.commit).toBeUndefined();
      await expect(service.getCatalog()).resolves.toMatchObject({ items: [], categories: [] });

      const restarted = createDesktopBundleRegistrySourceService(options);
      await expect(restarted.listSources()).resolves.toEqual([
        expect.objectContaining({ status: "ready", itemCount: 0 }),
      ]);
      await expect(
        restarted.preparePublicationSources("expert", "expert:1234567890abcdef"),
      ).resolves.toEqual([
        expect.objectContaining({
          selectable: true,
          categories: [
            expect.objectContaining({ id: "general" }),
            expect.objectContaining({ id: "software-development" }),
            expect.objectContaining({ id: "research" }),
            expect.objectContaining({ id: "product-design" }),
            expect.objectContaining({ id: "content-creation" }),
            expect.objectContaining({ id: "productivity" }),
            expect.objectContaining({ id: "education" }),
          ],
        }),
      ]);

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
      await commitAll(remote, "Initial source content");

      await expect(restarted.refreshSource(status.id)).resolves.toMatchObject({
        status: "ready",
        itemCount: 1,
        commit: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      });
      await expect(
        restarted.updateSource({ sourceId: status.id, name: "Invalid Edit", branch: "missing" }),
      ).rejects.toThrow(/branch was not found/u);
      await expect(restarted.listSources()).resolves.toEqual([
        expect.objectContaining({ name: "Empty Source", remote: expect.any(String) }),
      ]);
      await expect(restarted.getCatalog()).resolves.toMatchObject({
        items: [
          expect.objectContaining({
            id: "reviewer",
            avatarId: "pragma.avatar.expert.07",
          }),
        ],
      });

      const replacementRemote = join(root, "replacement-remote");
      await mkdir(replacementRemote, { recursive: true });
      await execFileAsync("git", ["-C", replacementRemote, "init"]);
      await expect(
        restarted.updateSource({
          sourceId: status.id,
          name: "Renamed Empty Source",
          remote: `https://pragma-empty-source.test${replacementRemote}`,
          branch: null,
        }),
      ).resolves.toMatchObject({
        id: status.id,
        name: "Renamed Empty Source",
        status: "ready",
        itemCount: 0,
      });
      await expect(restarted.listSources()).resolves.toEqual([
        expect.objectContaining({
          name: "Renamed Empty Source",
          remote: `https://pragma-empty-source.test${replacementRemote}`,
          status: "ready",
          itemCount: 0,
        }),
      ]);
    } finally {
      restoreEnvironment("GIT_CONFIG_COUNT", previous[0]);
      restoreEnvironment("GIT_CONFIG_KEY_0", previous[1]);
      restoreEnvironment("GIT_CONFIG_VALUE_0", previous[2]);
    }
  });

  it("discovers configs without decoding Bundles and falls back to a stale snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-source-sync-"));
    temporaryRoots.push(root);
    const remote = join(root, "remote");
    await mkdir(join(remote, "experts/general/reviewer/versions/1.0.0"), { recursive: true });
    await mkdir(join(remote, "knowledge-bases/general/handbook/versions/1.0.0"), {
      recursive: true,
    });
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
    await writeFile(
      join(remote, "knowledge-bases/general/handbook/config.yaml"),
      knowledgeBaseSourceItemConfig(),
      "utf8",
    );
    await writeFile(
      join(remote, "knowledge-bases/general/handbook/versions/1.0.0/bundle.pragma"),
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
      expect(status).toMatchObject({ status: "ready", itemCount: 2 });
      await expect(service.getCatalog()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ id: "reviewer", kind: "expert" }),
          expect.objectContaining({ id: "handbook", kind: "knowledge-base" }),
        ]),
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
        itemCount: 2,
      });
      await expect(service.getCatalog()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ id: "reviewer" }),
          expect.objectContaining({ id: "handbook" }),
        ]),
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

  it("initializes an empty source, commits with the system identity, pushes, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-source-publish-"));
    temporaryRoots.push(root);
    const remote = join(root, "remote.git");
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "--bare", "--initial-branch=master", remote]);
    const previous = {
      HOME: process.env.HOME,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.HOME = home;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "url.file:///.insteadOf";
    process.env.GIT_CONFIG_VALUE_0 = "https://pragma-publish.test/";
    try {
      await execFileAsync("git", ["config", "--global", "user.name", "Pragma Publisher"]);
      await execFileAsync("git", ["config", "--global", "user.email", "publisher@pragma.invalid"]);
      const service = createDesktopBundleRegistrySourceService({
        sourcesPath: join(root, "data/sources.json"),
        cacheRoot: join(root, "cache"),
      });
      const source = await service.addSource({
        name: "Publishing Source",
        remote: `https://pragma-publish.test${remote}`,
      });
      const bundlePath = await createExpertBundle(root);
      const decoded = await decodePragmaBundle({ kind: "file", path: bundlePath });
      const request = {
        bundlePath,
        bundleFingerprint: decoded.manifest.bundleFingerprint,
        rootRef: "expert:1xddvess309a6gme",
        kind: "expert" as const,
        metadata: {
          itemId: "reviewer",
          name: "Reviewer",
          summary: "Reviews code",
          description: "Reviews code changes.",
          authorName: "Pragma Publisher",
          license: "MIT",
          tags: ["review"],
          avatarId: "pragma.avatar.expert.07",
        },
        target: { sourceId: source.id, categoryId: "general", version: "1.0.0" },
      };

      await expect(service.publishBundleToSource(request)).resolves.toMatchObject({
        status: "published",
        commit: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      });
      await expect(service.publishBundleToSource(request)).resolves.toMatchObject({
        status: "already_published",
      });
      await expect(
        service.publishBundleToSource({
          ...request,
          target: { ...request.target, version: "1.0.1" },
        }),
      ).resolves.toMatchObject({
        status: "published",
      });
      const checkout = join(root, "checkout");
      await execFileAsync("git", ["clone", "--branch", "main", `file://${remote}`, checkout]);
      await expect(
        readFile(join(checkout, "experts/general/reviewer/config.yaml"), "utf8"),
      ).resolves.toMatch(/avatarId: pragma\.avatar\.expert\.07[\s\S]*latestVersion: 1\.0\.1/u);
    } finally {
      restoreEnvironment("HOME", previous.HOME);
      restoreEnvironment("GIT_CONFIG_COUNT", previous.GIT_CONFIG_COUNT);
      restoreEnvironment("GIT_CONFIG_KEY_0", previous.GIT_CONFIG_KEY_0);
      restoreEnvironment("GIT_CONFIG_VALUE_0", previous.GIT_CONFIG_VALUE_0);
    }
  }, 15_000);
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

async function createExpertBundle(root: string): Promise<string> {
  const projectPath = join(root, "project.yaml");
  const bundlePath = join(root, "reviewer.pragma");
  await writeFile(
    projectPath,
    formatPragmaYaml({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Bundle",
      resources: [
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "RuntimeProfile",
          metadata: {
            id: "knr7p5b7qc55wv92",
            name: "Runtime",
            description: "Runtime",
            tags: [],
          },
          spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
        },
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "Expert",
          metadata: {
            id: "1xddvess309a6gme",
            name: "Reviewer",
            description: "Reviews code",
            tags: ["review"],
          },
          spec: {
            scope: "review",
            instructions: "Review code.",
            runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
            capabilities: [],
            toolApprovals: {},
            contextStores: [],
            plugins: [],
            tools: [],
          },
        },
      ],
    }),
  );
  const project = await loadPragmaProject(projectPath);
  try {
    const exported = await project.exportBundle({ roots: ["expert:1xddvess309a6gme"] });
    await writeFile(bundlePath, exported.bytes);
    return bundlePath;
  } finally {
    await project.dispose();
  }
}

function sourceManifest(): string {
  return `schemaVersion: pragma.bundle-source/v2
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
  knowledge-base:
    categories: *categories
`;
}

function sourceItemConfig(): string {
  return `schemaVersion: pragma.bundle-source-item/v2
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
avatarId: pragma.avatar.expert.07
latestVersion: 1.0.0
createdAt: 2026-08-31T00:00:00.000Z
updatedAt: 2026-08-31T00:00:00.000Z
`;
}

function knowledgeBaseSourceItemConfig(): string {
  return `schemaVersion: pragma.bundle-source-item/v2
id: handbook
rootRef: context-store:kqh4nx7rx26mb3e7
name:
  default: Handbook
summary:
  default: Shared handbook
description:
  default: Shared knowledge-base content.
author:
  name: Pragma
license: MIT
tags:
  - handbook
latestVersion: 1.0.0
createdAt: 2026-08-31T00:00:00.000Z
updatedAt: 2026-08-31T00:00:00.000Z
`;
}
