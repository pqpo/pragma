import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { withFileLock } from "../../file-lock.ts";
import { encodePragmaPathSegment, type PragmaPaths } from "../../pragma-paths.ts";
import {
  runtimeSessionRecordMigrationChain,
  type RuntimeSessionRecord,
} from "../runtime-session/index.ts";
import { RUNTIME_SESSION_CATALOG_V1_SCHEMA_SQL } from "./schemas/v1.ts";

const CATALOG_SCHEMA_VERSION = 1;
const initializedCatalogs = new Set<string>();

const LegacyMigrationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.runtime-session-catalog-migration/v1"),
    manifests: z.array(z.string().min(1)),
    claims: z.array(z.string().min(1)),
  })
  .strict();

const LegacyOwnershipClaimSchema = z
  .object({
    schemaVersion: z.literal("pragma.runtime-session-owner/v1"),
    systemSessionId: z.string().min(1),
    owner: z
      .object({
        type: z.enum(["expert-session", "flow-execution"]),
        ownerId: z.string().min(1),
        contextId: z.string().min(1).optional(),
        invocationId: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

const StorageDeletionJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.storage-deletion/v1"),
    deletionId: z.string().uuid(),
    owner: z.object({ type: z.string().min(1), id: z.string().min(1) }).strict(),
    status: z.enum(["preparing", "moving", "catalog-pending", "trashed"]),
    sources: z.array(z.object({ label: z.string().min(1), path: z.string().min(1) }).strict()),
    moved: z.array(z.string().min(1)),
    runtimeSessionOwnerIds: z.array(z.string().min(1)),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

type StorageDeletionJournal = z.infer<typeof StorageDeletionJournalSchema>;

export function runtimeSessionCatalogPath(paths: PragmaPaths): string {
  return join(paths.runtimeSessionsRoot(), "catalog.sqlite");
}

export async function openRuntimeSessionCatalog(paths: PragmaPaths): Promise<DatabaseSync> {
  const path = await ensureCatalogInitialized(paths);
  await assertCatalogVersion(path);
  const database = openWritableCatalog(path);
  try {
    if (hasPendingCatalogDeletions(database)) {
      await withRuntimeSessionCatalogDeletionLock(paths, () =>
        recoverPendingCatalogDeletions(paths, database),
      );
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function hasPendingCatalogDeletions(database: DatabaseSync): boolean {
  const row = database
    .prepare("SELECT 1 AS pending FROM runtime_session_deletions LIMIT 1")
    .get() as { readonly pending: number } | undefined;
  return row !== undefined;
}

export async function withRuntimeSessionCatalogDeletionLock<TValue>(
  paths: PragmaPaths,
  operation: () => Promise<TValue>,
): Promise<TValue> {
  return await withFileLock(`${runtimeSessionCatalogPath(paths)}.deletion.lock`, operation, {
    operation: "runtime-session-catalog-deletion",
    timeoutMs: 60_000,
  });
}

async function ensureCatalogInitialized(paths: PragmaPaths): Promise<string> {
  const path = runtimeSessionCatalogPath(paths);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (initializedCatalogs.has(path) && !(await pathExists(path))) initializedCatalogs.delete(path);
  if (!initializedCatalogs.has(path)) {
    await withFileLock(`${path}.migration.lock`, async () => {
      await initializeCatalog(paths, path);
      initializedCatalogs.add(path);
    });
  }
  return path;
}

export async function prepareRuntimeSessionCatalogDeletion(
  paths: PragmaPaths,
  deletionId: string,
  ownerIds: readonly string[],
): Promise<void> {
  const path = await ensureCatalogInitialized(paths);
  await assertCatalogVersion(path);
  const database = openWritableCatalog(path);
  try {
    database
      .prepare(
        `INSERT INTO runtime_session_deletions(
           deletion_id, owner_ids_json, status, prepared_at
         ) VALUES (?, ?, 'prepared', ?)`,
      )
      .run(deletionId, JSON.stringify([...new Set(ownerIds)]), new Date().toISOString());
  } finally {
    database.close();
  }
}

export async function commitRuntimeSessionCatalogDeletion(
  paths: PragmaPaths,
  deletionId: string,
): Promise<number> {
  const database = await openCatalogWithoutRecovery(paths);
  try {
    return commitPreparedDeletion(database, deletionId);
  } finally {
    database.close();
  }
}

export async function completeRuntimeSessionCatalogDeletion(
  paths: PragmaPaths,
  deletionId: string,
): Promise<void> {
  const database = await openCatalogWithoutRecovery(paths);
  try {
    database
      .prepare(
        "DELETE FROM runtime_session_deletions WHERE deletion_id = ? AND status = 'committed'",
      )
      .run(deletionId);
  } finally {
    database.close();
  }
}

async function initializeCatalog(paths: PragmaPaths, path: string): Promise<void> {
  const metadata = await stat(path).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (metadata !== undefined && metadata.size > 0) {
    await assertCatalogVersion(path);
  } else {
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
      database.exec(RUNTIME_SESSION_CATALOG_V1_SCHEMA_SQL);
      database
        .prepare("INSERT INTO metadata(key, value) VALUES ('schema_version', ?)")
        .run(String(CATALOG_SCHEMA_VERSION));
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    } finally {
      database.close();
    }
  }

  const database = openWritableCatalog(path);
  try {
    const imported = database
      .prepare("SELECT value FROM metadata WHERE key = 'legacy_imported'")
      .get() as { readonly value: string } | undefined;
    if (imported?.value !== "true") await importLegacyRecords(paths, database);
    else await recoverLegacyCleanup(paths);
  } finally {
    database.close();
  }
}

async function assertCatalogVersion(path: string): Promise<void> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = database
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { readonly value: string } | undefined;
    if (version?.value !== String(CATALOG_SCHEMA_VERSION)) {
      throw new Error(`unsupported runtime-session catalog version: ${String(version?.value)}`);
    }
  } catch (error) {
    throw unsupported(path, error);
  } finally {
    database.close();
  }
}

function openWritableCatalog(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  return database;
}

async function openCatalogWithoutRecovery(paths: PragmaPaths): Promise<DatabaseSync> {
  const path = runtimeSessionCatalogPath(paths);
  await assertCatalogVersion(path);
  return openWritableCatalog(path);
}

async function importLegacyRecords(paths: PragmaPaths, database: DatabaseSync): Promise<void> {
  const imported: {
    readonly manifest: string;
    readonly manifestSource: string;
    readonly claim: string;
    readonly claimSource: string | undefined;
    readonly record: RuntimeSessionRecord;
  }[] = [];
  for (const owner of await readDirectory(paths.runtimeSessionsRoot())) {
    if (!owner.isDirectory()) continue;
    const directory = join(paths.runtimeSessionsRoot(), owner.name);
    for (const session of await readDirectory(directory)) {
      if (!session.isDirectory()) continue;
      const manifest = join(directory, session.name, "session.json");
      try {
        const manifestSource = await readFile(manifest, "utf8");
        const value = JSON.parse(manifestSource) as unknown;
        const record = runtimeSessionRecordMigrationChain.upgrade(value).value;
        const claim = join(
          paths.runtimeSessionOwnersRoot(),
          `${encodePragmaPathSegment(record.systemSessionId)}.json`,
        );
        const claimSource = await readMatchingLegacyClaim(claim, record);
        imported.push({
          manifest,
          manifestSource,
          claim,
          claimSource,
          record,
        });
      } catch (error) {
        if (!isNotFound(error)) throw unsupported(manifest, error);
      }
    }
  }
  const ordered = imported.toSorted((left, right) => left.manifest.localeCompare(right.manifest));
  const backup = ordered
    .map(({ manifest, manifestSource, claim, claimSource }) =>
      JSON.stringify({ manifest, manifestSource, claim, claimSource: claimSource ?? null }),
    )
    .join("\n");
  if (ordered.length > 0) await writeMigrationBackup(paths, `${backup}\n`);
  const journal = migrationJournalPath(paths);
  await writeJsonAtomic(
    journal,
    LegacyMigrationJournalSchema.parse({
      schemaVersion: "pragma.runtime-session-catalog-migration/v1",
      manifests: ordered.map(({ manifest }) => manifest),
      claims: ordered.map(({ claim }) => claim),
    }),
  );
  database.exec("BEGIN IMMEDIATE;");
  try {
    const insert = database.prepare(
      `INSERT INTO runtime_sessions(system_session_id, owner_id, owner_type, record_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const { record } of ordered) {
      insert.run(
        record.systemSessionId,
        record.owner.ownerId,
        record.owner.type,
        JSON.stringify(record),
        record.updatedAt,
      );
    }
    database
      .prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('legacy_imported', 'true')")
      .run();
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  await cleanupLegacyFiles(paths, {
    manifests: ordered.map(({ manifest }) => manifest),
    claims: ordered.map(({ claim }) => claim),
  });
  await rm(journal, { force: true });
}

async function readMatchingLegacyClaim(
  claimPath: string,
  record: RuntimeSessionRecord,
): Promise<string | undefined> {
  let claimSource: string;
  try {
    claimSource = await readFile(claimPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const claim = LegacyOwnershipClaimSchema.parse(JSON.parse(claimSource) as unknown);
  if (
    claim.systemSessionId !== record.systemSessionId ||
    JSON.stringify(claim.owner) !== JSON.stringify(record.owner)
  ) {
    throw new Error(`Runtime Session ownership claim mismatch: ${claimPath}`);
  }
  return claimSource;
}

async function recoverLegacyCleanup(paths: PragmaPaths): Promise<void> {
  const journal = migrationJournalPath(paths);
  try {
    const value = LegacyMigrationJournalSchema.parse(
      JSON.parse(await readFile(journal, "utf8")) as unknown,
    );
    await cleanupLegacyFiles(paths, value);
    await rm(journal, { force: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function cleanupLegacyFiles(
  paths: PragmaPaths,
  files: { readonly manifests: readonly string[]; readonly claims: readonly string[] },
): Promise<void> {
  for (const manifest of files.manifests) {
    assertCanonicalLegacyManifest(paths, manifest);
    await rm(manifest, { force: true });
  }
  for (const claim of files.claims) {
    assertCanonicalLegacyClaim(paths, claim);
    await rm(claim, { force: true });
  }
}

async function recoverPendingCatalogDeletions(
  paths: PragmaPaths,
  database: DatabaseSync,
): Promise<void> {
  const pending = database
    .prepare(
      `SELECT deletion_id AS deletionId, owner_ids_json AS ownerIdsJson, status
       FROM runtime_session_deletions ORDER BY prepared_at, deletion_id`,
    )
    .all() as {
    readonly deletionId: string;
    readonly ownerIdsJson: string;
    readonly status: string;
  }[];
  for (const row of pending) {
    const ownerIds = z.array(z.string().min(1)).parse(JSON.parse(row.ownerIdsJson) as unknown);
    const journalPath = join(paths.deletionJournalRoot(), `${row.deletionId}.json`);
    const journal = StorageDeletionJournalSchema.parse(
      JSON.parse(await readFile(journalPath, "utf8")) as unknown,
    );
    assertDeletionJournal(paths, journal, row.deletionId, ownerIds);
    if (row.status === "prepared") {
      const resumed = await resumeStorageMoves(paths, journal, journalPath);
      await writeJsonAtomic(journalPath, { ...resumed, status: "catalog-pending" });
      commitPreparedDeletion(database, row.deletionId);
    } else if (row.status !== "committed") {
      throw new Error(`Invalid Runtime Session catalog deletion status: ${row.status}`);
    }
    const current = StorageDeletionJournalSchema.parse(
      JSON.parse(await readFile(journalPath, "utf8")) as unknown,
    );
    await writeJsonAtomic(journalPath, {
      ...current,
      status: "trashed",
      completedAt: current.completedAt ?? new Date().toISOString(),
    });
    database
      .prepare("DELETE FROM runtime_session_deletions WHERE deletion_id = ?")
      .run(row.deletionId);
  }
}

function commitPreparedDeletion(database: DatabaseSync, deletionId: string): number {
  const pending = database
    .prepare(
      `SELECT owner_ids_json AS ownerIdsJson, status
       FROM runtime_session_deletions WHERE deletion_id = ?`,
    )
    .get(deletionId) as { readonly ownerIdsJson: string; readonly status: string } | undefined;
  if (pending === undefined) {
    throw new Error(`Runtime Session catalog deletion not found: ${deletionId}`);
  }
  if (pending.status === "committed") return 0;
  if (pending.status !== "prepared") {
    throw new Error(`Invalid Runtime Session catalog deletion status: ${pending.status}`);
  }
  const ownerIds = z.array(z.string().min(1)).parse(JSON.parse(pending.ownerIdsJson) as unknown);
  database.exec("BEGIN IMMEDIATE;");
  try {
    const remove = database.prepare("DELETE FROM runtime_sessions WHERE owner_id = ?");
    let deleted = 0;
    for (const ownerId of ownerIds) deleted += Number(remove.run(ownerId).changes);
    database
      .prepare("UPDATE runtime_session_deletions SET status = 'committed' WHERE deletion_id = ?")
      .run(deletionId);
    database.exec("COMMIT;");
    return deleted;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

async function resumeStorageMoves(
  paths: PragmaPaths,
  journal: StorageDeletionJournal,
  journalPath: string,
): Promise<StorageDeletionJournal> {
  const moved = new Set(journal.moved);
  const trashRoot = join(paths.trashRoot(), journal.deletionId);
  for (const source of journal.sources) {
    assertDeletionSource(paths, journal.deletionId, source);
    const target = join(trashRoot, source.label);
    const [sourceExists, targetExists] = await Promise.all([
      pathExists(source.path),
      pathExists(target),
    ]);
    if (sourceExists && targetExists) {
      throw new Error(`Storage deletion source and target both exist: ${source.path}`);
    }
    if (sourceExists) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(source.path, target);
    }
    if (sourceExists || targetExists) moved.add(source.label);
    const next = { ...journal, status: "moving" as const, moved: [...moved] };
    await writeJsonAtomic(journalPath, next);
    journal = next;
  }
  return journal;
}

function assertDeletionJournal(
  paths: PragmaPaths,
  journal: StorageDeletionJournal,
  deletionId: string,
  ownerIds: readonly string[],
): void {
  if (journal.deletionId !== deletionId) throw new Error("Storage deletion id mismatch.");
  const journalOwners = [...journal.runtimeSessionOwnerIds].sort();
  const catalogOwners = [...ownerIds].sort();
  if (JSON.stringify(journalOwners) !== JSON.stringify(catalogOwners)) {
    throw new Error(`Runtime Session owner mismatch for deletion ${deletionId}.`);
  }
  for (const source of journal.sources) assertDeletionSource(paths, deletionId, source);
}

function assertDeletionSource(
  paths: PragmaPaths,
  deletionId: string,
  source: { readonly label: string; readonly path: string },
): void {
  assertPathWithin(paths.root, source.path, "storage deletion source");
  if (source.label.startsWith("/") || source.label.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid storage deletion label: ${source.label}`);
  }
  assertPathWithin(
    join(paths.trashRoot(), deletionId),
    join(paths.trashRoot(), deletionId, source.label),
    "storage deletion target",
  );
}

function assertCanonicalLegacyManifest(paths: PragmaPaths, path: string): void {
  assertPathWithin(paths.runtimeSessionsRoot(), path, "Runtime Session manifest");
  const parts = relative(resolve(paths.runtimeSessionsRoot()), resolve(path)).split(sep);
  if (parts.length !== 3 || parts[2] !== "session.json") {
    throw new Error(`Unsafe Runtime Session manifest: ${path}`);
  }
}

function assertCanonicalLegacyClaim(paths: PragmaPaths, path: string): void {
  assertPathWithin(paths.runtimeSessionOwnersRoot(), path, "Runtime Session ownership claim");
  const parts = relative(resolve(paths.runtimeSessionOwnersRoot()), resolve(path)).split(sep);
  if (parts.length !== 1 || !parts[0]?.endsWith(".json")) {
    throw new Error(`Unsafe Runtime Session ownership claim: ${path}`);
  }
}

function assertPathWithin(root: string, candidate: string, label: string): void {
  const child = relative(resolve(root), resolve(candidate));
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Unsafe ${label}: ${candidate}`);
  }
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function writeMigrationBackup(paths: PragmaPaths, content: string): Promise<void> {
  const root = join(paths.archivesRoot(), "storage-migrations", "runtime-session-catalog-v1");
  const path = join(root, "records.jsonl");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== content) {
      throw new Error(`Conflicting Runtime Session migration backup: ${path}`);
    }
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function migrationJournalPath(paths: PragmaPaths): string {
  return join(paths.runtimeSessionsRoot(), ".catalog-migration.json");
}

function unsupported(file: string, cause?: unknown): Error {
  return new Error(`unsupported-state-version: ${file}`, { cause });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
