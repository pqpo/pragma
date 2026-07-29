import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PragmaPaths, type Expert } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareManagedCodexHome } from "../src/codex-home.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("managed Codex home", () => {
  it("copies only private configuration and links authentication and the host plugin cache", async () => {
    const root = await createTemporaryRoot("pragma-codex-home-");
    const sharedCodexHome = join(root, "shared");
    const sessionDir = join(root, "session");
    const pluginCache = join(sharedCodexHome, "plugins", "cache");
    await mkdir(pluginCache, { recursive: true });
    await Promise.all([
      writeFile(join(sharedCodexHome, "auth.json"), '{"auth_mode":"chatgpt"}'),
      writeFile(join(sharedCodexHome, ".env"), "HTTPS_PROXY=http://127.0.0.1:7890\n"),
      writeFile(join(sharedCodexHome, "config.toml"), 'model = "gpt-test"\n'),
      writeFile(join(pluginCache, "catalog.json"), "{}\n"),
    ]);

    const managed = await prepare(root, sessionDir, sharedCodexHome);

    await expect(readFile(join(managed.home, "auth.json"), "utf8")).resolves.toContain("chatgpt");
    await expect(readFile(join(managed.home, ".env"), "utf8")).resolves.toContain("HTTPS_PROXY");
    await expect(readFile(join(managed.home, "config.toml"), "utf8")).resolves.toContain(
      "gpt-test",
    );
    expect(await realpath(join(managed.home, "plugins", "cache"))).toBe(
      await realpath(pluginCache),
    );
    expect((await lstat(join(managed.home, "plugins"))).isSymbolicLink()).toBe(false);
    expect(managed.sqliteHome).not.toContain(managed.home);
  });

  it("shares only the rebuildable plugin cache while keeping concurrent session state private", async () => {
    const root = await createTemporaryRoot("pragma-codex-concurrent-");
    const source = join(root, "source");
    const pluginCache = join(source, "plugins", "cache");
    await mkdir(pluginCache, { recursive: true });
    await writeFile(join(pluginCache, "catalog.json"), "shared");

    const [first, second] = await Promise.all([
      prepare(root, join(root, "first"), source),
      prepare(root, join(root, "second"), source),
    ]);

    expect(await realpath(join(first.home, "plugins", "cache"))).toBe(
      await realpath(join(second.home, "plugins", "cache")),
    );
    expect(join(first.home, "sessions")).not.toBe(join(second.home, "sessions"));
    expect(first.sqliteHome).not.toBe(second.sqliteHome);
    await writeFile(join(first.home, "sessions", "first.jsonl"), "private");
    await expect(stat(join(second.home, "sessions", "first.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("copies Agent Skills into each Context instead of sharing mutable skill paths", async () => {
    const root = await createTemporaryRoot("pragma-codex-private-skills-");
    const source = join(root, "source");
    const skill = join(root, "skill");
    await Promise.all([
      mkdir(join(source, "plugins", "cache"), { recursive: true }),
      mkdir(skill, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(skill, "SKILL.md"), "---\nname: review\ndescription: Review\n---\nOriginal\n"),
      writeFile(join(skill, "reference.md"), "shared source"),
    ]);
    const agent = {
      workspace: root,
      skills: {
        skills: [
          {
            type: "local",
            name: "review",
            description: "Review",
            path: join(skill, "SKILL.md"),
          },
        ],
      },
    } as unknown as Expert;

    const [first, second] = await Promise.all([
      prepare(root, join(root, "first"), source, agent),
      prepare(root, join(root, "second"), source, agent),
    ]);
    const firstSkill = join(first.home, "skills", "review");
    const secondSkill = join(second.home, "skills", "review");

    expect((await lstat(firstSkill)).isSymbolicLink()).toBe(false);
    expect((await lstat(secondSkill)).isSymbolicLink()).toBe(false);
    expect(await realpath(firstSkill)).not.toBe(await realpath(secondSkill));
    await writeFile(join(firstSkill, "reference.md"), "first only");
    await expect(readFile(join(secondSkill, "reference.md"), "utf8")).resolves.toBe(
      "shared source",
    );
  });

  it("does not traverse or copy packages, general cache, or plugin staging trees", async () => {
    const root = await createTemporaryRoot("pragma-codex-minimal-");
    const source = join(root, "source");
    await Promise.all([
      mkdir(join(source, "plugins", "cache"), { recursive: true }),
      mkdir(join(source, "plugins", ".remote-plugin-install-staging", "large"), {
        recursive: true,
      }),
      mkdir(join(source, "packages"), { recursive: true }),
      mkdir(join(source, "cache"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(source, "plugins", "cache", "catalog.json"), "shared"),
      writeFile(join(source, "plugins", ".remote-plugin-install-staging", "large", "ignored"), "x"),
      writeFile(join(source, "packages", "ignored"), "x"),
      writeFile(join(source, "cache", "ignored"), "x"),
    ]);
    await symlink(join(source, "packages"), join(source, "packages", "cycle"), "dir");

    const managed = await prepare(root, join(root, "session"), source);

    await expect(stat(join(managed.home, "packages"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(managed.home, "cache"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(managed.home, "plugins", ".remote-plugin-install-staging")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readdir(join(root, "pragma", "cache", "runtimes", "codex", "bases")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("seeds the models cache once, preserves a task refresh, and invalidates it on config changes", async () => {
    const root = await createTemporaryRoot("pragma-codex-model-cache-");
    const source = join(root, "source");
    const session = join(root, "session");
    await mkdir(join(source, "plugins", "cache"), { recursive: true });
    await Promise.all([
      writeFile(join(source, "config.toml"), 'model_provider = "provider-a"\n'),
      writeFile(join(source, "models_cache.json"), '{"source":"shared"}'),
    ]);

    const first = await prepare(root, session, source);
    await expect(readFile(join(first.home, "models_cache.json"), "utf8")).resolves.toContain(
      "shared",
    );
    await writeFile(join(first.home, "models_cache.json"), '{"source":"task"}');

    const reused = await prepare(root, session, source);
    await expect(readFile(join(reused.home, "models_cache.json"), "utf8")).resolves.toContain(
      "task",
    );

    await writeFile(join(source, "config.toml"), 'model_provider = "provider-b"\n');
    const changed = await prepare(root, session, source);
    await expect(stat(join(changed.home, "models_cache.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(changed.home, "config.toml"), "utf8")).resolves.toContain(
      "provider-b",
    );
  });

  it("copies a relative model catalog and rejects traversal outside the source home", async () => {
    const root = await createTemporaryRoot("pragma-codex-model-catalog-");
    const source = join(root, "source");
    await mkdir(join(source, "catalogs"), { recursive: true });
    await Promise.all([
      mkdir(join(source, "plugins", "cache"), { recursive: true }),
      writeFile(join(source, "config.toml"), 'model_catalog_json = "catalogs/models.json"\n'),
      writeFile(join(source, "catalogs", "models.json"), '{"models":[]}'),
    ]);

    const managed = await prepare(root, join(root, "valid"), source);
    await expect(
      readFile(join(managed.home, "catalogs", "models.json"), "utf8"),
    ).resolves.toContain("models");

    await writeFile(join(source, "config.toml"), 'model_catalog_json = "../outside.json"\n');
    await expect(prepare(root, join(root, "invalid"), source)).rejects.toThrow(
      "must stay inside CODEX_HOME",
    );
  });

  it("uses a private empty plugin cache when the host has no cache", async () => {
    const root = await createTemporaryRoot("pragma-codex-empty-plugin-cache-");
    const source = join(root, "source");
    await mkdir(source, { recursive: true });

    const managed = await prepare(root, join(root, "session"), source);

    const cache = join(managed.home, "plugins", "cache");
    expect((await stat(cache)).isDirectory()).toBe(true);
    expect((await lstat(cache)).isSymbolicLink()).toBe(false);
  });

  it("migrates known legacy base links without deleting the base or private session state", async () => {
    const root = await createTemporaryRoot("pragma-codex-legacy-base-");
    const source = join(root, "source");
    const session = join(root, "session");
    const paths = new PragmaPaths({ pragmaHome: join(root, "pragma") });
    const fingerprint = "a".repeat(64);
    const base = join(paths.codexRuntimeCacheRoot(), "bases", fingerprint);
    await Promise.all([
      mkdir(join(source, "plugins", "cache"), { recursive: true }),
      mkdir(join(base, "plugins", "cache"), { recursive: true }),
      mkdir(join(base, "packages"), { recursive: true }),
      mkdir(join(base, "cache"), { recursive: true }),
      mkdir(join(session, "home", "sessions"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(source, "plugins", "cache", "catalog.json"), "host"),
      writeFile(join(base, "plugins", "cache", "catalog.json"), "legacy"),
      writeFile(join(session, "home", "sessions", "resume.jsonl"), "keep"),
      symlink(join(base, "plugins"), join(session, "home", "plugins"), "dir"),
      symlink(join(base, "packages"), join(session, "home", "packages"), "dir"),
      symlink(join(base, "cache"), join(session, "home", "cache"), "dir"),
      writeFile(
        join(session, "layout.json"),
        `${JSON.stringify({
          schemaVersion: "pragma.codex-home/v2",
          sharedBase: base,
          baseFingerprint: fingerprint,
        })}\n`,
      ),
    ]);

    const managed = await prepareWithPaths(root, session, source, paths);

    expect(await realpath(join(managed.home, "plugins", "cache"))).toBe(
      await realpath(join(source, "plugins", "cache")),
    );
    await expect(readFile(join(managed.home, "sessions", "resume.jsonl"), "utf8")).resolves.toBe(
      "keep",
    );
    await expect(stat(join(managed.home, "packages"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(managed.home, "cache"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(session, "layout.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(base)).resolves.toBeDefined();
  });
});

async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function prepare(root: string, sessionDir: string, source: string, agent?: Expert) {
  return await prepareWithPaths(
    root,
    sessionDir,
    source,
    new PragmaPaths({ pragmaHome: join(root, "pragma") }),
    agent,
  );
}

async function prepareWithPaths(
  root: string,
  sessionDir: string,
  source: string,
  paths: PragmaPaths,
  agent: Expert = { workspace: root } as Expert,
) {
  return await prepareManagedCodexHome({
    agent,
    sessionDir,
    pragmaPaths: paths,
    env: { CODEX_HOME: source },
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}
