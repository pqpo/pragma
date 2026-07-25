import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PragmaPaths } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeDesktopStorage } from "./storage-bootstrap.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Desktop storage bootstrap", () => {
  it("backs up an old root and creates storage v4 without importing old state", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pragma-storage-bootstrap-"));
    roots.push(parent);
    const paths = new PragmaPaths({ pragmaHome: join(parent, ".pragma") });
    await mkdir(join(paths.root, "state", "runtime-sessions"), { recursive: true });
    await writeFile(join(paths.root, "state", "runtime-sessions", "old.json"), "old");

    const result = await initializeDesktopStorage({
      paths,
      now: new Date("2026-07-22T00:00:00.000Z"),
    });

    expect(result.created).toBe(true);
    await expect(readFile(paths.storageVersion(), "utf8")).resolves.toContain("pragma.storage/v4");
    await expect(
      readFile(join(result.legacyBackup!, "state", "runtime-sessions", "old.json"), "utf8"),
    ).resolves.toBe("old");
  });

  it("moves an expired legacy backup through the supplied system trash operation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pragma-storage-expiry-"));
    roots.push(parent);
    const paths = new PragmaPaths({ pragmaHome: join(parent, ".pragma") });
    const first = await initializeDesktopStorage({
      paths,
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(first.created).toBe(true);
    const backup = join(parent, "legacy");
    await mkdir(backup);
    await mkdir(paths.storageStateRoot(), { recursive: true });
    await writeFile(
      join(paths.storageStateRoot(), "legacy-backup.json"),
      JSON.stringify({ path: backup, expiresAt: "2026-07-08T00:00:00.000Z", retain: false }),
    );
    const trashItem = vi.fn(async () => undefined);

    await initializeDesktopStorage({
      paths,
      now: new Date("2026-07-22T00:00:00.000Z"),
      trashItem,
    });

    expect(trashItem).toHaveBeenCalledWith(backup);
  });

  it("resumes bootstrap after the legacy root was renamed before v4 was created", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pragma-storage-resume-"));
    roots.push(parent);
    const paths = new PragmaPaths({ pragmaHome: join(parent, ".pragma") });
    const backup = `${paths.root}-backup-2026-07-22T00-00-00-000Z`;
    await mkdir(paths.root, { recursive: true });
    await writeFile(join(paths.root, "legacy.json"), "legacy");
    await writeFile(
      `${paths.root}.storage-v4-bootstrap.json`,
      JSON.stringify({
        schemaVersion: "pragma.storage-bootstrap/v1",
        path: backup,
        createdAt: "2026-07-22T00:00:00.000Z",
        expiresAt: "2026-07-29T00:00:00.000Z",
      }),
    );
    await rename(paths.root, backup);

    const result = await initializeDesktopStorage({
      paths,
      now: new Date("2026-07-22T00:00:01.000Z"),
    });

    expect(result).toEqual({ created: true, legacyBackup: backup });
    await expect(readFile(paths.storageVersion(), "utf8")).resolves.toContain("pragma.storage/v4");
    await expect(readFile(join(backup, "legacy.json"), "utf8")).resolves.toBe("legacy");
    await expect(
      readFile(join(paths.storageStateRoot(), "legacy-backup.json"), "utf8"),
    ).resolves.toContain(backup);
    await expect(readFile(`${paths.root}.storage-v4-bootstrap.json`, "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
