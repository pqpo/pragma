import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  it("exposes authentication and copies environment-based runtime configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-codex-home-"));
    temporaryDirectories.push(root);
    const sharedCodexHome = join(root, "shared");
    const sessionDir = join(root, "session");
    await mkdir(sharedCodexHome, { recursive: true });
    await Promise.all([
      writeFile(join(sharedCodexHome, "auth.json"), '{"auth_mode":"chatgpt"}'),
      writeFile(join(sharedCodexHome, ".env"), "HTTPS_PROXY=http://127.0.0.1:7890\n"),
    ]);

    await mkdir(join(sharedCodexHome, "plugins", "cache"), { recursive: true });
    await writeFile(join(sharedCodexHome, "plugins", "cache", "catalog.json"), "{}\n");
    const managed = await prepareManagedCodexHome({
      agent: { workspace: root } as Expert,
      sessionDir,
      pragmaPaths: new PragmaPaths({ pragmaHome: join(root, "pragma") }),
      env: { CODEX_HOME: sharedCodexHome },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(join(managed.home, "auth.json"), "utf8")).resolves.toContain("chatgpt");
    await expect(readFile(join(managed.home, ".env"), "utf8")).resolves.toContain("HTTPS_PROXY");
    await expect(
      readFile(join(managed.home, "plugins", "cache", "catalog.json"), "utf8"),
    ).resolves.toBe("{}\n");
    expect(managed.sqliteHome).not.toContain(managed.home);
  });

  it("shares the immutable base while keeping session state private", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-codex-shared-base-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    await mkdir(join(source, "plugins", "cache"), { recursive: true });
    await writeFile(join(source, "plugins", "cache", "catalog.json"), "shared");
    const paths = new PragmaPaths({ pragmaHome: join(root, "pragma") });
    const prepare = async (name: string) =>
      await prepareManagedCodexHome({
        agent: { workspace: root } as Expert,
        sessionDir: join(root, name),
        pragmaPaths: paths,
        env: { CODEX_HOME: source },
        logger: { warn: vi.fn() },
      });

    const [first, second] = await Promise.all([prepare("first"), prepare("second")]);

    expect(first.sharedBase).toBe(second.sharedBase);
    expect(await realpath(join(first.home, "plugins"))).toBe(
      await realpath(join(second.home, "plugins")),
    );
    expect(join(first.home, "sessions")).not.toBe(join(second.home, "sessions"));
    expect(first.sqliteHome).not.toBe(second.sqliteHome);
  });
});
