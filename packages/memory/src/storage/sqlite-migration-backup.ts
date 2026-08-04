import { rename, rm, stat } from "node:fs/promises";
import { backup, type DatabaseSync } from "node:sqlite";

export interface SqliteMigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (database: DatabaseSync) => void;
}

export async function runAdjacentSqliteMigrations(input: {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly family: string;
  readonly targetVersion: number;
  readonly migrations: readonly SqliteMigrationStep[];
}): Promise<void> {
  let version = readVersion(input.database);
  if (version > input.targetVersion) {
    throw new Error(`unsupported-state-version:${input.family}/v${version}`);
  }
  while (version < input.targetVersion) {
    const matches = input.migrations.filter((step) => step.fromVersion === version);
    if (matches.length !== 1 || matches[0]!.toVersion !== version + 1) {
      throw new Error(`missing-adjacent-migration:${input.family}/v${version}`);
    }
    const step = matches[0]!;
    await ensureSqliteMigrationBackup(input.database, input.databasePath, version);
    step.migrate(input.database);
    const migratedVersion = readVersion(input.database);
    if (migratedVersion !== step.toVersion) {
      throw new Error(`invalid-migration-result:${input.family}/v${version}-to-v${step.toVersion}`);
    }
    version = migratedVersion;
  }
}

export function assertFreshSqliteDatabase(database: DatabaseSync, family: string): void {
  const row = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name LIMIT 1`,
    )
    .get() as { readonly name: string } | undefined;
  if (row !== undefined) {
    throw new Error(`corrupt-state-version:${family}/v0-with-table:${row.name}`);
  }
}

export async function ensureSqliteMigrationBackup(
  database: DatabaseSync,
  databasePath: string,
  sourceVersion: number,
): Promise<void> {
  const destination = migrationBackupPath(databasePath, sourceVersion);
  try {
    await stat(destination);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${destination}.tmp`;
  await rm(temporary, { force: true });
  await backup(database, temporary);
  await rename(temporary, destination);
}

export async function removeExpiredSqliteMigrationBackup(
  databasePath: string,
  sourceVersion: number,
  cutoffMs: number,
): Promise<void> {
  const path = migrationBackupPath(databasePath, sourceVersion);
  try {
    if ((await stat(path)).mtimeMs <= cutoffMs) await rm(path, { force: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export function migrationBackupPath(databasePath: string, sourceVersion: number): string {
  return `${databasePath}.v${sourceVersion}.backup`;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function readVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  return row.user_version;
}
