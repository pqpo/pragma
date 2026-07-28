import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PragmaPaths } from "../src/storage/pragma-paths.ts";
import { moveOwnedStorageToTrash } from "../src/storage/deletion-transaction.ts";
import {
  assertStorageWriteAllowed,
  runStorageMaintenance,
} from "../src/storage/storage-maintenance.ts";
import { DEFAULT_STORAGE_POLICY } from "../src/storage/storage-policy.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("runStorageMaintenance", () => {
  it("removes empty and stale project view lease directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-storage-maintenance-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const snapshotHash = "a".repeat(64);
    const orphanHash = "b".repeat(64);
    const leasesRoot = join(paths.cacheRoot(), "project-view-leases");
    const staleLeaseDirectory = join(leasesRoot, snapshotHash);
    const emptyLeaseDirectory = join(leasesRoot, orphanHash);

    await mkdir(join(paths.projectViewsCacheRoot(), snapshotHash), { recursive: true });
    await mkdir(staleLeaseDirectory, { recursive: true });
    await writeFile(join(staleLeaseDirectory, "stale.lease"), '{"pid":-1}\n');
    await mkdir(emptyLeaseDirectory, { recursive: true });

    await runStorageMaintenance({
      paths,
      policy: {
        ...DEFAULT_STORAGE_POLICY,
        cacheLimitBytes: Number.MAX_SAFE_INTEGER,
        cacheTtlMs: Number.MAX_SAFE_INTEGER,
      },
    });

    await expect(stat(staleLeaseDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(emptyLeaseDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.projectViewsCacheRoot(), snapshotHash))).resolves.toBeDefined();
  });

  it("keeps a project view and lease directory while its lease process is alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-storage-maintenance-active-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const snapshotHash = "c".repeat(64);
    const projectView = join(paths.projectViewsCacheRoot(), snapshotHash);
    const leaseDirectory = join(paths.cacheRoot(), "project-view-leases", snapshotHash);
    const lease = join(leaseDirectory, "active.lease");

    await mkdir(projectView, { recursive: true });
    await writeFile(join(projectView, "pragma.yaml"), "active view\n");
    await mkdir(leaseDirectory, { recursive: true });
    await writeFile(lease, `${JSON.stringify({ pid: process.pid })}\n`);

    await runStorageMaintenance({
      paths,
      policy: {
        ...DEFAULT_STORAGE_POLICY,
        cacheLimitBytes: 0,
        cacheTtlMs: 0,
      },
    });

    await expect(stat(projectView)).resolves.toBeDefined();
    await expect(stat(leaseDirectory)).resolves.toBeDefined();
    await expect(stat(lease)).resolves.toBeDefined();
  });

  it("keeps a leased Codex base, removes an unleased base, and ignores cache metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-storage-codex-base-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const activeFingerprint = "d".repeat(64);
    const staleFingerprint = "e".repeat(64);
    const bases = join(paths.codexRuntimeCacheRoot(), "bases");
    const activeBase = join(bases, activeFingerprint);
    const staleBase = join(bases, staleFingerprint);
    const sourceIndex = join(bases, "source-index");
    const leaseDirectory = join(paths.codexRuntimeCacheRoot(), "base-leases", activeFingerprint);
    await Promise.all([
      mkdir(activeBase, { recursive: true }),
      mkdir(staleBase, { recursive: true }),
      mkdir(sourceIndex, { recursive: true }),
      mkdir(leaseDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(activeBase, ".complete"), `${activeFingerprint}\n`),
      writeFile(join(staleBase, ".complete"), `${staleFingerprint}\n`),
      writeFile(join(sourceIndex, "source.json"), "{}\n"),
      writeFile(join(leaseDirectory, "active.lease"), JSON.stringify({ pid: process.pid })),
    ]);

    await runStorageMaintenance({
      paths,
      policy: {
        ...DEFAULT_STORAGE_POLICY,
        cacheLimitBytes: 0,
        cacheTtlMs: 0,
      },
    });

    await expect(stat(activeBase)).resolves.toBeDefined();
    await expect(stat(staleBase)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sourceIndex)).resolves.toBeDefined();
  });

  it("purges completed fresh trash under hard-limit pressure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-storage-maintenance-pressure-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const source = join(paths.dataRoot(), "large-owner");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "payload.bin"), Buffer.alloc(8_192));
    await moveOwnedStorageToTrash({
      paths,
      owner: { type: "test", id: "large-owner" },
      sources: [{ label: "owner", path: source }],
    });

    await expect(
      assertStorageWriteAllowed(paths, {
        ...DEFAULT_STORAGE_POLICY,
        globalSoftLimitBytes: 1_024,
        globalHardLimitBytes: 4_096,
        trashTtlMs: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toBeUndefined();
    await expect(readdir(paths.trashRoot())).resolves.toEqual([]);
  });
});
