import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
      env: { QODER_CONFIG_DIR: shared },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(join(config, ".auth", "user"), "utf8")).resolves.toBe(
      "credential",
    );
    await expect(
      readFile(join(config, ".models", "user", "catalog-v6"), "utf8"),
    ).resolves.toBe("encrypted-catalog");
    await expect(readFile(join(config, "projects", "missing"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    await writeFile(
      join(session, "config", ".models", "user", "catalog-v6"),
      "session-catalog",
    );

    const config = await prepareManagedQoderConfig({
      sessionDir: session,
      env: { QODER_CONFIG_DIR: shared },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(join(config, ".auth", "user"), "utf8")).resolves.toBe(
      "session-login",
    );
    await expect(
      readFile(join(config, ".models", "user", "catalog-v6"), "utf8"),
    ).resolves.toBe("session-catalog");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-qoder-config-"));
  temporaryRoots.push(root);
  return root;
}
