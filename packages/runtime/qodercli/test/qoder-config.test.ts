import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareManagedQoderConfig } from "../src/qoder-config.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("prepareManagedQoderConfig", () => {
  it("snapshots local login state while keeping session state private", async () => {
    const root = await temporaryRoot();
    const shared = join(root, "shared");
    const session = join(root, "session");
    await mkdir(join(shared, ".auth"), { recursive: true });
    await writeFile(join(shared, ".auth", "user"), "credential");

    const config = await prepareManagedQoderConfig({
      sessionDir: session,
      env: { QODER_CONFIG_DIR: shared },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(join(config, ".auth", "user"), "utf8")).resolves.toBe(
      "credential",
    );
    await expect(readFile(join(config, "projects", "missing"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not overwrite login state already owned by a restored session", async () => {
    const root = await temporaryRoot();
    const shared = join(root, "shared");
    const session = join(root, "session");
    await mkdir(join(shared, ".auth"), { recursive: true });
    await mkdir(join(session, "config", ".auth"), { recursive: true });
    await writeFile(join(shared, ".auth", "user"), "new-global-login");
    await writeFile(join(session, "config", ".auth", "user"), "session-login");

    const config = await prepareManagedQoderConfig({
      sessionDir: session,
      env: { QODER_CONFIG_DIR: shared },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(join(config, ".auth", "user"), "utf8")).resolves.toBe(
      "session-login",
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-qoder-config-"));
  temporaryRoots.push(root);
  return root;
}
