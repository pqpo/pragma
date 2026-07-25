import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";

const STORAGE_SCHEMA = "pragma.storage/v4" as const;
const PREVIOUS_STORAGE_SCHEMA = "pragma.storage/v3" as const;
const BOOTSTRAP_SCHEMA = "pragma.storage-bootstrap/v1" as const;
const LEGACY_BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface LegacyBackupRecord {
  readonly path: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface DesktopStorageBootstrapResult {
  readonly created: boolean;
  readonly legacyBackup?: string | undefined;
}

export async function initializeDesktopStorage(input: {
  readonly paths: PragmaPaths;
  readonly now?: Date | undefined;
  readonly trashItem?: ((path: string) => Promise<void>) | undefined;
}): Promise<DesktopStorageBootstrapResult> {
  const now = input.now ?? new Date();
  return await withFileLock(`${input.paths.root}.storage-v4.lock`, async () => {
    const pending = await readBootstrapJournal(input.paths);
    const marker = await readStorageMarker(input.paths);
    if (marker !== undefined) {
      if (marker.schemaVersion === PREVIOUS_STORAGE_SCHEMA) {
        await writeJsonAtomic(`${input.paths.root}.storage-v3-to-v4.json`, {
          schemaVersion: "pragma.storage-migration/v1",
          sourceSchema: PREVIOUS_STORAGE_SCHEMA,
          targetSchema: STORAGE_SCHEMA,
          startedAt: now.toISOString(),
        });
        await writeJsonAtomic(input.paths.storageVersion(), {
          schemaVersion: STORAGE_SCHEMA,
          migratedAt: now.toISOString(),
        });
        await rm(`${input.paths.root}.storage-v3-to-v4.json`, { force: true });
      } else if (marker.schemaVersion !== STORAGE_SCHEMA) {
        throw new Error(`Unsupported Pragma storage schema: ${String(marker.schemaVersion)}.`);
      }
      if (pending !== undefined) {
        await assertBackupExists(pending.path);
        await writeLegacyBackupManifest(input.paths, pending);
        await rm(bootstrapJournalPath(input.paths), { force: true });
      }
      await trashExpiredLegacyBackup(input.paths, now, input.trashItem);
      return {
        created: false,
        ...(pending === undefined ? {} : { legacyBackup: pending.path }),
      };
    }

    const existing = await listDirectory(input.paths.root);
    let legacyBackup = pending;
    if (legacyBackup !== undefined) {
      const backupExists = await pathExists(legacyBackup.path);
      if (existing.length > 0 && backupExists) {
        throw new Error(
          `Cannot resume Pragma storage bootstrap because both ${input.paths.root} and ${legacyBackup.path} contain data.`,
        );
      }
      if (existing.length > 0) await rename(input.paths.root, legacyBackup.path);
      else if (!backupExists) {
        throw new Error(
          `Cannot resume Pragma storage bootstrap because its legacy backup is missing: ${legacyBackup.path}.`,
        );
      }
    } else if (existing.length > 0) {
      const path = `${input.paths.root}-backup-${formatTimestamp(now)}`;
      legacyBackup = {
        path,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + LEGACY_BACKUP_TTL_MS).toISOString(),
      };
      await writeJsonAtomic(bootstrapJournalPath(input.paths), {
        schemaVersion: BOOTSTRAP_SCHEMA,
        ...legacyBackup,
      });
      await rename(input.paths.root, path);
    }
    await mkdir(input.paths.root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(input.paths.storageVersion(), {
      schemaVersion: STORAGE_SCHEMA,
      createdAt: now.toISOString(),
    });
    if (legacyBackup !== undefined) {
      await writeLegacyBackupManifest(input.paths, legacyBackup);
      await rm(bootstrapJournalPath(input.paths), { force: true });
    }
    return {
      created: true,
      ...(legacyBackup === undefined ? {} : { legacyBackup: legacyBackup.path }),
    };
  });
}

async function readBootstrapJournal(paths: PragmaPaths): Promise<LegacyBackupRecord | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(bootstrapJournalPath(paths), "utf8")) as unknown;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== BOOTSTRAP_SCHEMA ||
    !("path" in parsed) ||
    typeof parsed.path !== "string" ||
    !("createdAt" in parsed) ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    !("expiresAt" in parsed) ||
    typeof parsed.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.expiresAt))
  ) {
    throw new Error(`Invalid Pragma storage bootstrap journal: ${bootstrapJournalPath(paths)}.`);
  }
  return { path: parsed.path, createdAt: parsed.createdAt, expiresAt: parsed.expiresAt };
}

async function writeLegacyBackupManifest(
  paths: PragmaPaths,
  backup: LegacyBackupRecord,
): Promise<void> {
  await mkdir(paths.storageStateRoot(), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(paths.storageStateRoot(), "legacy-backup.json"), {
    schemaVersion: "pragma.legacy-storage-backup/v1",
    ...backup,
    retain: false,
  });
}

async function assertBackupExists(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    throw new Error(`Pragma storage bootstrap legacy backup is missing: ${path}.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function bootstrapJournalPath(paths: PragmaPaths): string {
  return `${paths.root}.storage-v4-bootstrap.json`;
}

async function trashExpiredLegacyBackup(
  paths: PragmaPaths,
  now: Date,
  trashItem: ((path: string) => Promise<void>) | undefined,
): Promise<void> {
  const manifestPath = join(paths.storageStateRoot(), "legacy-backup.json");
  let manifest:
    | {
        readonly path?: unknown;
        readonly expiresAt?: unknown;
        readonly retain?: unknown;
      }
    | undefined;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (
    manifest?.retain === true ||
    typeof manifest?.path !== "string" ||
    typeof manifest.expiresAt !== "string" ||
    Date.parse(manifest.expiresAt) > now.getTime()
  ) {
    return;
  }
  if (trashItem !== undefined) await trashItem(manifest.path);
  else await rm(manifest.path, { recursive: true, force: true });
  await rm(manifestPath, { force: true });
}

async function readStorageMarker(
  paths: PragmaPaths,
): Promise<{ readonly schemaVersion?: unknown } | undefined> {
  try {
    return JSON.parse(await readFile(paths.storageVersion(), "utf8")) as {
      readonly schemaVersion?: unknown;
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
