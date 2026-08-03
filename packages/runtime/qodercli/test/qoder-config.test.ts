import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupManagedQoderExternalCommands,
  prepareManagedQoderConfig,
  resolveSharedQoderConfigDir,
} from "../src/qoder-config.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("prepareManagedQoderConfig", () => {
  it("uses only the explicit Qoder config directory or the native default", () => {
    expect(resolveSharedQoderConfigDir({ QODER_CONFIG_DIR: "/custom/qoder" })).toBe(
      "/custom/qoder",
    );
    expect(resolveSharedQoderConfigDir({ QODER_CLI_HOME: "/ambiguous/home" })).toBe(
      join(homedir(), ".qoder"),
    );
  });

  it("snapshots local login state while keeping session state private", async () => {
    const root = await temporaryRoot();
    const shared = join(root, "shared");
    const session = join(root, "session");
    await mkdir(join(shared, ".auth"), { recursive: true });
    await mkdir(join(shared, ".models", "user"), { recursive: true });
    await writeFile(join(shared, ".auth", "user"), "credential");
    await writeFile(join(shared, ".models", "user", "catalog-v6"), "encrypted-catalog");

    const config = await prepareManagedQoderConfig({
      sessionDir: session,
      externalCommandsCacheDir: join(root, "cache", "external-commands"),
      env: { QODER_CONFIG_DIR: shared },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(join(config.configDir, ".auth", "user"), "utf8")).resolves.toBe(
      "credential",
    );
    await expect(
      readFile(join(config.configDir, ".models", "user", "catalog-v6"), "utf8"),
    ).resolves.toBe("encrypted-catalog");
    await expect(
      readFile(join(config.configDir, "projects", "missing"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite login state already owned by a restored session", async () => {
    const root = await temporaryRoot();
    const shared = join(root, "shared");
    const session = join(root, "session");
    await mkdir(join(shared, ".auth"), { recursive: true });
    await mkdir(join(shared, ".models", "user"), { recursive: true });
    await mkdir(join(session, "config", ".auth"), { recursive: true });
    await mkdir(join(session, "config", ".models", "user"), { recursive: true });
    await writeFile(join(shared, ".auth", "user"), "new-global-login");
    await writeFile(join(shared, ".models", "user", "catalog-v6"), "new-global-catalog");
    await writeFile(join(session, "config", ".auth", "user"), "session-login");
    await writeFile(join(session, "config", ".models", "user", "catalog-v6"), "session-catalog");

    const config = await prepareManagedQoderConfig({
      sessionDir: session,
      externalCommandsCacheDir: join(root, "cache", "external-commands"),
      env: { QODER_CONFIG_DIR: shared },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(join(config.configDir, ".auth", "user"), "utf8")).resolves.toBe(
      "session-login",
    );
    await expect(
      readFile(join(config.configDir, ".models", "user", "catalog-v6"), "utf8"),
    ).resolves.toBe("session-catalog");
  });

  it("links fresh sessions to one shared external-command cache", async () => {
    const root = await temporaryRoot();
    const cache = join(root, "cache", "external-commands");
    const first = await prepareManagedQoderConfig({
      sessionDir: join(root, "first"),
      externalCommandsCacheDir: cache,
      logger: { warn: vi.fn() },
    });
    const second = await prepareManagedQoderConfig({
      sessionDir: join(root, "second"),
      externalCommandsCacheDir: cache,
      logger: { warn: vi.fn() },
    });

    expect(first.externalCommandsCacheDir).toBe(cache);
    expect(second.externalCommandsCacheDir).toBe(cache);
    await expect(realpath(join(first.configDir, "external-commands"))).resolves.toBe(
      await realpath(cache),
    );
    await expect(realpath(join(second.configDir, "external-commands"))).resolves.toBe(
      await realpath(cache),
    );
    expect((await lstat(join(first.configDir, "external-commands"))).isSymbolicLink()).toBe(true);
  });

  it("preserves an existing session-local external-command directory", async () => {
    const root = await temporaryRoot();
    const session = join(root, "legacy");
    const legacy = join(session, "config", "external-commands");
    await mkdir(join(legacy, "qoder-core", "current"), { recursive: true });
    await writeFile(join(legacy, "qoder-core", "current", "command.json"), "legacy");

    const config = await prepareManagedQoderConfig({
      sessionDir: session,
      externalCommandsCacheDir: join(root, "cache", "external-commands"),
      logger: { warn: vi.fn() },
    });

    expect(config.externalCommandsCacheDir).toBeUndefined();
    expect((await lstat(legacy)).isDirectory()).toBe(true);
    await expect(
      readFile(join(legacy, "qoder-core", "current", "command.json"), "utf8"),
    ).resolves.toBe("legacy");
  });

  it("removes completed downloads and only stale unlocked temporary installs", async () => {
    const root = await temporaryRoot();
    const cache = join(root, "external-commands");
    const command = join(cache, "qoder-core");
    const current = join(command, "current");
    const stale = join(command, ".tmp-stale");
    const fresh = join(command, ".tmp-fresh");
    await Promise.all([
      mkdir(current, { recursive: true }),
      mkdir(stale, { recursive: true }),
      mkdir(fresh, { recursive: true }),
    ]);
    await writeFile(join(current, "download-qoder-core.zip"), "archive");
    await writeFile(join(current, "bin"), "binary");
    await utimes(stale, new Date(0), new Date(0));

    await cleanupManagedQoderExternalCommands(cache, { now: 10_000, temporaryTtlMs: 1_000 });

    await expect(stat(join(current, "download-qoder-core.zip"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(current, "bin"))).resolves.toBeDefined();
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fresh)).resolves.toBeDefined();

    await mkdir(stale);
    await utimes(stale, new Date(0), new Date(0));
    await writeFile(join(current, "download-live.zip"), "archive");
    await mkdir(join(cache, "locks"), { recursive: true });
    await writeFile(join(cache, "locks", "qoder-core.lock"), JSON.stringify({ pid: process.pid }));
    await cleanupManagedQoderExternalCommands(cache, { now: 10_000, temporaryTtlMs: 1_000 });
    await expect(stat(stale)).resolves.toBeDefined();
    await expect(stat(join(current, "download-live.zip"))).resolves.toBeDefined();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-qoder-config-"));
  temporaryRoots.push(root);
  return root;
}
