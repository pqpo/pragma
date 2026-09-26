import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { PragmaPaths } from "./pragma-paths.ts";
import { withFileLock } from "./file-lock.ts";
import {
  clearRebuildableCache,
  emptyCompletedTrash,
  inspectStorageCleanup,
  runTransientStorageMaintenance,
} from "./storage-maintenance.ts";
import { DEFAULT_STORAGE_POLICY } from "./storage-policy.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

it("clears rebuildable cache but preserves project views with an active lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-storage-cleanup-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  const unusedHash = "a".repeat(64);
  const activeHash = "b".repeat(64);
  const cache = join(paths.projectViewsCacheRoot(), unusedHash, "snapshot.json");
  const leasedView = join(paths.projectViewsCacheRoot(), activeHash, "snapshot.json");
  const compilerView = join(paths.projectViewsCacheRoot(), "compiler-derived-view", "pragma.yaml");
  const lease = join(paths.cacheRoot(), "project-view-leases", activeHash, "current.json");
  for (const path of [cache, leasedView, compilerView, lease])
    await mkdir(join(path, ".."), { recursive: true });
  await writeFile(cache, "unused");
  await writeFile(leasedView, "active");
  await writeFile(compilerView, "derived");
  await writeFile(lease, JSON.stringify({ pid: process.pid }));

  const overview = await inspectStorageCleanup(paths);
  expect(overview.clearableCacheBytes).toBe(6);
  const result = await clearRebuildableCache(paths);
  expect(result.deletedEntries).toBe(1);
  await expect(readFile(cache)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(leasedView, "utf8")).resolves.toBe("active");
  await expect(readFile(compilerView, "utf8")).resolves.toBe("derived");
});

it("preserves a view leased while automatic maintenance waits for its view lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-storage-view-race-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  const hash = "c".repeat(64);
  const view = join(paths.projectViewsCacheRoot(), hash);
  const leaseDirectory = join(paths.cacheRoot(), "project-view-leases", hash);
  const lock = join(paths.cacheRoot(), "project-view-locks", hash);
  await mkdir(view, { recursive: true });
  await writeFile(join(view, "pragma.yaml"), "active");

  let maintenance: Promise<unknown> | undefined;
  await withFileLock(lock, async () => {
    maintenance = runTransientStorageMaintenance({
      paths,
      policy: { ...DEFAULT_STORAGE_POLICY, cacheTtlMs: 0, cacheLimitBytes: 0 },
    });
    await mkdir(leaseDirectory, { recursive: true });
    await writeFile(join(leaseDirectory, "current.lease"), JSON.stringify({ pid: process.pid }));
  });
  await maintenance;
  await expect(readFile(join(view, "pragma.yaml"), "utf8")).resolves.toBe("active");
});

it("permanently clears only Trash entries with completed valid journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-trash-cleanup-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  await mkdir(paths.trashRoot(), { recursive: true });
  await mkdir(paths.deletionJournalRoot(), { recursive: true });
  await mkdir(join(paths.trashRoot(), "completed"));
  await mkdir(join(paths.trashRoot(), "pending"));
  await writeFile(join(paths.trashRoot(), "completed", "data"), "done");
  await writeFile(join(paths.trashRoot(), "pending", "data"), "keep");
  await writeFile(
    join(paths.deletionJournalRoot(), "completed.json"),
    JSON.stringify({
      schemaVersion: "pragma.storage-deletion/v1",
      deletionId: "completed",
      status: "trashed",
      completedAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    join(paths.deletionJournalRoot(), "pending.json"),
    JSON.stringify({
      schemaVersion: "pragma.storage-deletion/v1",
      deletionId: "pending",
      status: "moving",
      completedAt: new Date().toISOString(),
    }),
  );

  const overview = await inspectStorageCleanup(paths);
  expect(overview.clearableTrashEntries).toBe(1);
  const result = await emptyCompletedTrash(paths);
  expect(result.deletedEntries).toBe(1);
  await expect(readFile(join(paths.trashRoot(), "completed", "data"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(join(paths.trashRoot(), "pending", "data"), "utf8")).resolves.toBe("keep");
  await expect(readFile(join(paths.deletionJournalRoot(), "pending.json"))).resolves.toBeDefined();
});
