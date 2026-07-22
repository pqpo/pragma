import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "./pragma-paths.ts";

export interface StorageCatalogEntry {
  readonly storageClass: "data" | "state" | "archive" | "cache" | "temporary" | "trash";
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

export async function rebuildStorageCatalog(
  paths: PragmaPaths,
  now: Date = new Date(),
): Promise<void> {
  await mkdir(dirname(paths.storageCatalog()), { recursive: true, mode: 0o700 });
  const entries = (
    await Promise.all([
      scanOwners("data", paths.dataRoot()),
      scanOwners("state", paths.stateRoot(), new Set(["storage"])),
      scanOwners("archive", paths.archivesRoot()),
      scanOwners("cache", paths.cacheRoot()),
      scanOwners("temporary", paths.temporaryRoot()),
      scanOwners("trash", paths.trashRoot()),
    ])
  ).flat();
  try {
    writeCatalog(paths.storageCatalog(), entries, now);
  } catch (error) {
    const quarantine = `${paths.storageCatalog()}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
    await rename(paths.storageCatalog(), quarantine).catch(() => undefined);
    writeCatalog(paths.storageCatalog(), entries, now);
    if (error instanceof Error) {
      // The catalog is derived state; a successful rebuild is sufficient recovery.
    }
  }
}

export function readStorageCatalog(paths: PragmaPaths): readonly StorageCatalogEntry[] {
  const database = new DatabaseSync(paths.storageCatalog(), { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT storage_class AS storageClass, path, bytes, modified_at AS modifiedAt FROM storage_entries ORDER BY bytes DESC",
      )
      .all() as unknown as StorageCatalogEntry[];
  } finally {
    database.close();
  }
}

function writeCatalog(path: string, entries: readonly StorageCatalogEntry[], now: Date): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS storage_entries (
        path TEXT PRIMARY KEY,
        storage_class TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        scanned_at TEXT NOT NULL
      );
      BEGIN IMMEDIATE;
      DELETE FROM storage_entries;
    `);
    const insert = database.prepare(
      "INSERT INTO storage_entries(path, storage_class, bytes, modified_at, scanned_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const entry of entries) {
      insert.run(entry.path, entry.storageClass, entry.bytes, entry.modifiedAt, now.toISOString());
    }
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // No transaction was active.
    }
    throw error;
  } finally {
    database.close();
  }
}

async function scanOwners(
  storageClass: StorageCatalogEntry["storageClass"],
  root: string,
  excluded = new Set<string>(),
): Promise<StorageCatalogEntry[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  return await Promise.all(
    entries
      .filter((entry) => !excluded.has(entry.name) && !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = join(root, entry.name);
        const metadata = await stat(path);
        return {
          storageClass,
          path,
          bytes: entry.isDirectory() ? await directoryBytes(path) : metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        };
      }),
  );
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    total += entry.isDirectory()
      ? await directoryBytes(path)
      : entry.isFile()
        ? (await stat(path)).size
        : 0;
  }
  return total;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
