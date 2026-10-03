import { createHash, randomUUID } from "node:crypto";
import { type Dirent } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { FileSystemContextStore } from "@pragma/context-filesystem";
import { ContentAddressedStore, withFileLock } from "@pragma/core";
import {
  CONTEXT_STORE_FILE_MAX_BYTES,
  ContextStoreContentMetadataSchema,
  ContextStoreRevisionRecordSchema,
  ContextStoreSchema,
  ContextStoreSnapshotSchema,
  type ContextStore,
  type ContextStoreEntry,
  type ContextStoreRevisionRecord,
  type ContextStoreSnapshot,
} from "@pragma/shared";
export const MIGRATION_READY_FILE = ".pragma-migration-ready.json";

export const SNAPSHOT_STORAGE_MARKER = "snapshot-storage.json";

export const REVISION_LIST_STATE_FILE = "revision-list-state.json";

export const ContextStoreRevisionListStateSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-list-state/v1"),
    deletedRevisions: z.array(z.number().int().min(2)).max(100_000),
  })
  .strict();

export const ContextStoreSnapshotManifestV2Schema = z.object({
  schemaVersion: z.literal("pragma.context-store-snapshot-manifest/v2"),
  storeId: z.string().uuid(),
  revision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  objectTreeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.string().datetime(),
  directories: z.array(z.string()),
  fileCount: z.number().int().nonnegative(),
  logicalBytes: z.number().int().nonnegative(),
});

export const ContextStoreSnapshotStorageMarkerSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-snapshot-storage/v2"),
  storeId: z.string().uuid(),
  migratedAt: z.string().datetime(),
});

export type ContextStoreSnapshotManifestV2 = z.infer<typeof ContextStoreSnapshotManifestV2Schema>;

export const LegacyContextStoreV3Schema = z.object({
  schemaVersion: z.literal("pragma.context-store/v3"),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().max(500),
  type: z.literal("file"),
  status: z.enum(["ready", "needs_attention"]),
  source: z.object({ origin: z.enum(["created", "copied", "migrated"]) }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const LegacyContextStoreV1Schema = z.object({
  schemaVersion: z.literal("pragma.context-store/v1"),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  type: z.enum(["file", "note"]),
  source: z
    .object({
      path: z.string().trim().min(1).max(2_000),
      updateBehavior: z.enum(["watch", "manual"]),
    })
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const LegacyContextStoreV2Schema = z.object({
  schemaVersion: z.literal("pragma.context-store/v2"),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  type: z.literal("file"),
  status: z.enum(["ready", "needs_attention"]),
  source: z.object({ origin: z.enum(["created", "copied", "migrated"]) }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ContextStoreMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v1"),
  targetSchema: z.literal("pragma.context-store/v2"),
  sourcePath: z.string().min(1),
  temporaryFiles: z.string().min(1),
  targetManifest: LegacyContextStoreV2Schema,
});

export const ContextStoreMigrationReadySchema = z.object({
  schemaVersion: z.literal("pragma.context-store-migration-ready/v1"),
  storeId: z.string().uuid(),
});

export const ContextStoreMetadataMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-metadata-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v2"),
  targetSchema: z.literal("pragma.context-store/v3"),
  targetManifest: LegacyContextStoreV3Schema,
});

export const ContextStoreV4MigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-v4-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v3"),
  targetSchema: z.literal("pragma.context-store/v4"),
  targetManifest: ContextStoreSchema,
  snapshot: ContextStoreSnapshotSchema,
  record: ContextStoreRevisionRecordSchema,
});

export const ContextStoreRevisionJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-revision-journal/v1"),
  storeId: z.string().uuid(),
  previousFilesPath: z.string().min(1),
  stagedFilesPath: z.string().min(1),
  targetManifest: ContextStoreSchema,
  snapshot: ContextStoreSnapshotSchema,
  record: ContextStoreRevisionRecordSchema,
});

export type ContextStoreMigrationJournal = z.infer<typeof ContextStoreMigrationJournalSchema>;

export class ContextStoreStoreError extends Error {
  constructor(
    readonly code:
      | "config_invalid"
      | "store_not_found"
      | "content_exists"
      | "content_not_found"
      | "source_unavailable"
      | "invalid_entry"
      | "revision_conflict"
      | "expert_referenced"
      | "revision_drafts_present"
      | "draft_unreadable"
      | "active_mission_referenced"
      | "mission_message_queue_referenced"
      | "mission_referenced"
      | "mission_unmount_failed"
      | "legacy_note_unsupported",
    message: string,
  ) {
    super(message);
    this.name = "ContextStoreStoreError";
  }
}

export function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ContextStoreStoreError("config_invalid", `${label} is not valid JSON.`);
  }
}

export function assertSnapshotInvariant(
  id: string,
  snapshot: ContextStoreSnapshot,
  expected?: { readonly revision?: number; readonly snapshotHash?: string },
): void {
  const computed = hashSnapshotContent(snapshot.files, snapshot.directories);
  if (
    snapshot.storeId !== id ||
    (expected?.revision !== undefined && snapshot.revision !== expected.revision) ||
    (expected?.snapshotHash !== undefined && snapshot.snapshotHash !== expected.snapshotHash) ||
    snapshot.snapshotHash !== computed
  ) {
    throw new ContextStoreStoreError(
      "config_invalid",
      `Knowledge base ${id} has an inconsistent revision snapshot.`,
    );
  }
}

export function assertRevisionBundle(
  id: string,
  manifest: ContextStore,
  snapshot: ContextStoreSnapshot,
  record: ContextStoreRevisionRecord,
): void {
  assertSnapshotInvariant(id, snapshot, {
    revision: manifest.contentRevision,
    snapshotHash: manifest.snapshotHash,
  });
  if (
    manifest.id !== id ||
    record.storeId !== id ||
    record.revision !== snapshot.revision ||
    record.snapshotHash !== snapshot.snapshotHash ||
    (record.revision === 1
      ? record.parentRevision !== null
      : record.parentRevision !== record.revision - 1)
  ) {
    throw new ContextStoreStoreError(
      "config_invalid",
      `Knowledge base ${id} has an inconsistent revision transaction.`,
    );
  }
}

export async function copyMarkdownTree(sourcePath: string, targetPath: string): Promise<void> {
  const sourceRoot = await realpath(sourcePath);
  await walkSource(sourceRoot, async (path, entry) => {
    const target = join(targetPath, relative(sourceRoot, path));
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      return;
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") return;
    const content = await readFile(path);
    if (content.byteLength > CONTEXT_STORE_FILE_MAX_BYTES) {
      throw new ContextStoreStoreError(
        "source_unavailable",
        `Markdown file exceeds 1 MB: ${relative(sourceRoot, path)}`,
      );
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new ContextStoreStoreError(
        "source_unavailable",
        `Markdown file is not valid UTF-8: ${relative(sourceRoot, path)}`,
      );
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600, flag: "wx" });
  });
}

export async function walkSource(
  root: string,
  visit: (path: string, entry: Dirent<string>) => Promise<void>,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.toLowerCase() === ".git") continue;
    const path = join(root, entry.name);
    await visit(path, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await walkSource(path, visit);
  }
}

export function hashSnapshotContent(
  files: ContextStoreSnapshot["files"],
  directories: ContextStoreSnapshot["directories"],
): string {
  const hash = createHash("sha256");
  for (const file of files.toSorted((left, right) => left.id.localeCompare(right.id))) {
    hash.update(file.id);
    hash.update("\0");
    hash.update(JSON.stringify(file.metadata));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  for (const directory of directories.toSorted()) {
    hash.update("directory\0");
    hash.update(directory);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function collectManagedEntries(root: string): Promise<ContextStoreEntry[]> {
  const result: ContextStoreEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      const id = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        result.push({ id, kind: "directory" });
        await visit(path);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        const details = await stat(path, { bigint: true });
        result.push({
          id,
          kind: "file",
          sizeBytes: Number(details.size),
          revision: `${details.mtimeNs}:${details.size}`,
        });
      }
    }
  };
  await visit(root);
  return result;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readMigrationJournal(
  path: string,
  storeId: string,
): Promise<ContextStoreMigrationJournal | undefined> {
  let raw: unknown;
  try {
    raw = parseJson(await readFile(path, "utf8"), `${storeId}/v1-to-v2.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = ContextStoreMigrationJournalSchema.safeParse(raw);
  if (!parsed.success || parsed.data.storeId !== storeId) {
    throw new ContextStoreStoreError(
      "config_invalid",
      `Knowledge base ${storeId} has an invalid migration journal.`,
    );
  }
  return parsed.data;
}

export async function readContextStoreMetadataMigrationJournal(
  path: string,
): Promise<z.infer<typeof ContextStoreMetadataMigrationJournalSchema> | undefined> {
  let raw: unknown;
  try {
    raw = parseJson(await readFile(path, "utf8"), "knowledge base migration journal");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = ContextStoreMetadataMigrationJournalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContextStoreStoreError(
      "config_invalid",
      "Knowledge base metadata migration journal is invalid.",
    );
  }
  return parsed.data;
}

export async function hasMigrationReadyMarker(path: string, storeId: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = parseJson(
      await readFile(join(path, MIGRATION_READY_FILE), "utf8"),
      `${storeId}/${MIGRATION_READY_FILE}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const parsed = ContextStoreMigrationReadySchema.safeParse(raw);
  if (!parsed.success || parsed.data.storeId !== storeId) {
    throw new ContextStoreStoreError(
      "config_invalid",
      `Knowledge base ${storeId} has an invalid migration marker.`,
    );
  }
  return true;
}

export function assertMigrationTemporaryPath(storePath: string, temporaryFiles: string): void {
  const root = resolve(storePath);
  const temporary = resolve(temporaryFiles);
  const path = relative(root, temporary);
  if (
    path.length === 0 ||
    path.includes(sep) ||
    !path.startsWith(".files.") ||
    !path.endsWith(".migration") ||
    isAbsolute(path)
  ) {
    throw new ContextStoreStoreError(
      "config_invalid",
      "Knowledge base migration points outside its managed directory.",
    );
  }
}

export function assertRevisionTemporaryPath(
  storePath: string,
  temporaryFiles: string,
  prefix: string,
): void {
  const root = resolve(storePath);
  const temporary = resolve(temporaryFiles);
  const path = relative(root, temporary);
  if (path.length === 0 || path.includes(sep) || !path.startsWith(prefix) || isAbsolute(path)) {
    throw new ContextStoreStoreError(
      "config_invalid",
      "Knowledge base revision journal points outside its managed directory.",
    );
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createLocalHostContextStoreReader(options: {
  readonly storesPath: string;
  readonly trashItem?: ((path: string) => Promise<void>) | undefined;
}) {
  const storePath = (id: string) => join(options.storesPath, id);

  const manifestPath = (id: string) => join(storePath(id), "store.json");

  const contentRoot = (id: string) => join(storePath(id), "files");

  const revisionsRoot = (id: string) => join(storePath(id), "revisions");

  const revisionRoot = (id: string, revision: number) =>
    join(revisionsRoot(id), revision.toString().padStart(8, "0"));

  const snapshotPath = (id: string, revision: number) =>
    join(revisionRoot(id, revision), "snapshot.json");

  const revisionRecordPath = (id: string, revision: number) =>
    join(revisionRoot(id, revision), "record.json");

  const revisionListStatePath = (id: string) => join(storePath(id), REVISION_LIST_STATE_FILE);

  const snapshotStorageMarkerPath = (id: string) => join(storePath(id), SNAPSHOT_STORAGE_MARKER);

  const snapshotObjects = new ContentAddressedStore(
    join(dirname(options.storesPath), "objects", "sha256"),
  );

  const revisionLockPath = (id: string) => join(options.storesPath, ".locks", `${id}.lock`);

  const fileStoreAt = (rootDir: string) =>
    new FileSystemContextStore({
      rootDir,
      maxContextBytes: CONTEXT_STORE_FILE_MAX_BYTES,
    });

  const fileStore = (id: string) => fileStoreAt(contentRoot(id));

  const withRevisionLock = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const canonicalId = z.string().uuid().parse(id);
    return await withFileLock(revisionLockPath(canonicalId), operation);
  };

  // Publishers never acquire revision, draft or job locks inside this lock.
  // Deletion acquires it after the revision lock and holds it through removal.
  const withDraftPublicationLock = async <T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const canonicalId = z.string().uuid().parse(id);
    return await withFileLock(
      join(options.storesPath, ".locks", `${canonicalId}.draft-publication.lock`),
      operation,
    );
  };

  const readRevisionListState = async (id: string) => {
    try {
      return ContextStoreRevisionListStateSchema.parse(
        parseJson(
          await readFile(revisionListStatePath(id), "utf8"),
          `${id}/${REVISION_LIST_STATE_FILE}`,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          schemaVersion: "pragma.context-store-revision-list-state/v1" as const,
          deletedRevisions: [],
        };
      }
      throw error;
    }
  };

  const migrateFileStore = async (
    id: string,
    legacy: z.infer<typeof LegacyContextStoreV1Schema>,
  ): Promise<z.infer<typeof LegacyContextStoreV2Schema>> => {
    if (legacy.type === "note") {
      throw new ContextStoreStoreError(
        "legacy_note_unsupported",
        `Legacy context notes are no longer supported: ${legacy.name}.`,
      );
    }
    const sourcePath = legacy.source?.path;
    if (sourcePath === undefined) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Legacy file store ${legacy.name} has no source path.`,
      );
    }
    return await withFileLock(join(storePath(id), ".v2-migration.lock"), async () => {
      const latestRaw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const current = LegacyContextStoreV2Schema.safeParse(latestRaw);
      if (current.success) return current.data;

      const journal = join(storePath(id), "v1-to-v2.json");
      const migrated = () =>
        LegacyContextStoreV2Schema.parse({
          schemaVersion: "pragma.context-store/v2",
          id: legacy.id,
          name: legacy.name,
          description: legacy.description,
          type: "file",
          status: "ready",
          source: { origin: "migrated" },
          createdAt: legacy.createdAt,
          updatedAt: new Date().toISOString(),
        });

      const finalize = async (
        pending: ContextStoreMigrationJournal,
      ): Promise<z.infer<typeof LegacyContextStoreV2Schema>> => {
        await writeJsonAtomic(manifestPath(id), pending.targetManifest);
        await rm(join(contentRoot(id), MIGRATION_READY_FILE), { force: true });
        await rm(journal, { force: true });
        return pending.targetManifest;
      };
      const install = async (
        pending: ContextStoreMigrationJournal,
      ): Promise<z.infer<typeof LegacyContextStoreV2Schema>> => {
        assertMigrationTemporaryPath(storePath(id), pending.temporaryFiles);
        if (await hasMigrationReadyMarker(contentRoot(id), id)) {
          return await finalize(pending);
        }
        if (await pathExists(contentRoot(id))) {
          throw new ContextStoreStoreError(
            "config_invalid",
            `Cannot recover knowledge base ${id}: the managed files are incomplete.`,
          );
        }
        if (!(await hasMigrationReadyMarker(pending.temporaryFiles, id))) {
          await rm(pending.temporaryFiles, { recursive: true, force: true });
          await mkdir(pending.temporaryFiles, { recursive: true, mode: 0o700 });
          await copyMarkdownTree(pending.sourcePath, pending.temporaryFiles);
          await writeJsonAtomic(join(pending.temporaryFiles, MIGRATION_READY_FILE), {
            schemaVersion: "pragma.context-store-migration-ready/v1",
            storeId: id,
          });
        }
        await rename(pending.temporaryFiles, contentRoot(id));
        return await finalize(pending);
      };

      const pending = await readMigrationJournal(journal, id);
      if (pending !== undefined) {
        return await install(pending);
      }

      const transaction = ContextStoreMigrationJournalSchema.parse({
        schemaVersion: "pragma.context-store-migration/v1",
        storeId: id,
        sourceSchema: "pragma.context-store/v1",
        targetSchema: "pragma.context-store/v2",
        sourcePath,
        temporaryFiles: resolve(storePath(id), `.files.${randomUUID()}.migration`),
        targetManifest: migrated(),
      });
      await writeJsonAtomic(journal, transaction);
      try {
        return await install(transaction);
      } catch (error) {
        if (!(await hasMigrationReadyMarker(transaction.temporaryFiles, id))) {
          await rm(transaction.temporaryFiles, { recursive: true, force: true });
        }
        throw error;
      }
    });
  };

  const migrateV2Store = async (
    id: string,
    legacy: z.infer<typeof LegacyContextStoreV2Schema>,
  ): Promise<z.infer<typeof LegacyContextStoreV3Schema>> =>
    await withFileLock(join(storePath(id), ".v3-migration.lock"), async () => {
      const latestRaw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const current = LegacyContextStoreV3Schema.safeParse(latestRaw);
      if (current.success) return current.data;
      const latestLegacy = LegacyContextStoreV2Schema.safeParse(latestRaw);
      if (!latestLegacy.success || latestLegacy.data.id !== legacy.id) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${id} has invalid schema v2 data.`,
        );
      }
      const journalPath = join(storePath(id), "v2-to-v3.json");
      const pending = await readContextStoreMetadataMigrationJournal(journalPath);
      if (pending !== undefined) {
        if (pending.storeId !== id) {
          throw new ContextStoreStoreError(
            "config_invalid",
            `Knowledge base ${id} has a migration journal for another knowledge base.`,
          );
        }
        await writeJsonAtomic(manifestPath(id), pending.targetManifest);
        await rm(journalPath, { force: true });
        return pending.targetManifest;
      }
      const target = LegacyContextStoreV3Schema.safeParse({
        ...latestLegacy.data,
        schemaVersion: "pragma.context-store/v3",
      });
      if (!target.success) {
        const issue = target.error.issues[0];
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${id} exceeds the current text limits at ${issue?.path.join(".") || "metadata"}. The original data was not changed.`,
        );
      }
      const backupPath = join(storePath(id), "migration-backups", "store.v2.json");
      await writeJsonAtomic(backupPath, latestLegacy.data);
      await writeJsonAtomic(
        journalPath,
        ContextStoreMetadataMigrationJournalSchema.parse({
          schemaVersion: "pragma.context-store-metadata-migration/v1",
          storeId: id,
          sourceSchema: "pragma.context-store/v2",
          targetSchema: "pragma.context-store/v3",
          targetManifest: target.data,
        }),
      );
      await writeJsonAtomic(manifestPath(id), target.data);
      await rm(journalPath, { force: true });
      return target.data;
    });

  const buildSnapshot = async (
    id: string,
    revision: number,
    root = contentRoot(id),
    createdAt = new Date().toISOString(),
  ): Promise<ContextStoreSnapshot> => {
    const adapter = new FileSystemContextStore({
      rootDir: root,
      maxContextBytes: CONTEXT_STORE_FILE_MAX_BYTES,
      allowGitMetadataPaths: true,
    });
    const listed = await adapter.listContext();
    if (!listed.ok) {
      throw new ContextStoreStoreError("source_unavailable", listed.error.message);
    }
    const files = await Promise.all(
      listed.value
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map(async (item) => {
          const read = await adapter.readContext({
            id: item.id,
            offset: CONTEXT_STORE_FILE_MAX_BYTES,
          });
          if (!read.ok || read.value.contentRange.truncated) {
            throw new ContextStoreStoreError(
              "source_unavailable",
              read.ok ? `Markdown file exceeds 1 MB: ${item.id}` : read.error.message,
            );
          }
          return {
            id: item.id,
            content: read.value.content,
            metadata: ContextStoreContentMetadataSchema.parse(read.value.metadata),
          };
        }),
    );
    const directories = (await collectManagedEntries(root))
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.id)
      .toSorted();
    const snapshotHash = hashSnapshotContent(files, directories);
    return ContextStoreSnapshotSchema.parse({
      schemaVersion: "pragma.context-store-snapshot/v1",
      storeId: id,
      revision,
      snapshotHash,
      createdAt,
      directories,
      files,
    });
  };

  const persistSnapshotManifest = async (
    id: string,
    snapshot: ContextStoreSnapshot,
    objects = snapshotObjects,
  ): Promise<ContextStoreSnapshotManifestV2> => {
    assertSnapshotInvariant(id, snapshot);
    const files = new Map(
      snapshot.files.map((file) => [
        file.id,
        Buffer.from(
          `${JSON.stringify({ content: file.content, metadata: file.metadata })}\n`,
          "utf8",
        ),
      ]),
    );
    const stored = await objects.putSnapshot(files);
    return ContextStoreSnapshotManifestV2Schema.parse({
      schemaVersion: "pragma.context-store-snapshot-manifest/v2",
      storeId: id,
      revision: snapshot.revision,
      snapshotHash: snapshot.snapshotHash,
      objectTreeHash: stored.root.hash,
      createdAt: snapshot.createdAt,
      directories: snapshot.directories,
      fileCount: snapshot.files.length,
      logicalBytes: snapshot.files.reduce(
        (total, file) => total + Buffer.byteLength(file.content, "utf8"),
        0,
      ),
    });
  };

  const materializeStoredSnapshot = async (
    id: string,
    manifest: ContextStoreSnapshotManifestV2,
  ): Promise<ContextStoreSnapshot> => {
    if (manifest.storeId !== id) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} snapshot identity mismatch.`,
      );
    }
    const files: ContextStoreSnapshot["files"][number][] = [];
    const visit = async (treeHash: string, prefix: string): Promise<void> => {
      const tree = await snapshotObjects.readTree(treeHash);
      for (const entry of tree.entries) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.kind === "tree") {
          await visit(entry.hash, path);
          continue;
        }
        const raw = JSON.parse(
          Buffer.from(await snapshotObjects.readBlob(entry.hash)).toString("utf8"),
        ) as {
          readonly content?: unknown;
          readonly metadata?: unknown;
        };
        files.push(
          ContextStoreSnapshotSchema.shape.files.element.parse({
            id: path,
            content: raw.content,
            metadata: raw.metadata,
          }),
        );
      }
    };
    await visit(manifest.objectTreeHash, "");
    const snapshot = ContextStoreSnapshotSchema.parse({
      schemaVersion: "pragma.context-store-snapshot/v1",
      storeId: id,
      revision: manifest.revision,
      snapshotHash: manifest.snapshotHash,
      createdAt: manifest.createdAt,
      directories: manifest.directories,
      files: files.toSorted((left, right) => left.id.localeCompare(right.id)),
    });
    assertSnapshotInvariant(id, snapshot, {
      revision: manifest.revision,
      snapshotHash: manifest.snapshotHash,
    });
    if (snapshot.files.length !== manifest.fileCount) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} snapshot file count mismatch.`,
      );
    }
    return snapshot;
  };

  const readSnapshot = async (id: string, revision: number): Promise<ContextStoreSnapshot> => {
    const raw = parseJson(
      await readFile(snapshotPath(id, revision), "utf8"),
      `${id}/revisions/${revision}/snapshot.json`,
    );
    const manifest = ContextStoreSnapshotManifestV2Schema.safeParse(raw);
    if (!manifest.success) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} revision ${revision} has not completed its snapshot-storage upgrade.`,
      );
    }
    return await materializeStoredSnapshot(id, manifest.data);
  };

  const persistRevision = async (
    id: string,
    snapshot: ContextStoreSnapshot,
    record: ContextStoreRevisionRecord,
  ): Promise<void> => {
    assertSnapshotInvariant(id, snapshot, { revision: record.revision });
    if (
      record.storeId !== id ||
      record.snapshotHash !== snapshot.snapshotHash ||
      (record.revision === 1
        ? record.parentRevision !== null
        : record.parentRevision !== record.revision - 1)
    ) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} has an inconsistent revision record.`,
      );
    }
    await writeJsonAtomic(
      snapshotPath(id, snapshot.revision),
      await persistSnapshotManifest(id, snapshot),
    );
    await writeJsonAtomic(revisionRecordPath(id, record.revision), record);
  };

  const migrateV3Store = async (
    id: string,
    legacy: z.infer<typeof LegacyContextStoreV3Schema>,
  ): Promise<ContextStore> =>
    await withFileLock(join(storePath(id), ".v4-migration.lock"), async () => {
      const latestRaw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const current = ContextStoreSchema.safeParse(latestRaw);
      if (current.success) return current.data;
      const latestLegacy = LegacyContextStoreV3Schema.safeParse(latestRaw);
      if (!latestLegacy.success || latestLegacy.data.id !== legacy.id) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${id} has invalid schema v3 data.`,
        );
      }
      const journalPath = join(storePath(id), "v3-to-v4.json");
      let pending: z.infer<typeof ContextStoreV4MigrationJournalSchema> | undefined;
      try {
        pending = ContextStoreV4MigrationJournalSchema.parse(
          parseJson(await readFile(journalPath, "utf8"), `${id}/v3-to-v4.json`),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (pending === undefined) {
        const snapshot = await buildSnapshot(id, 1, contentRoot(id), new Date().toISOString());
        const target = ContextStoreSchema.parse({
          ...latestLegacy.data,
          schemaVersion: "pragma.context-store/v4",
          contentRevision: 1,
          snapshotHash: snapshot.snapshotHash,
        });
        const record = ContextStoreRevisionRecordSchema.parse({
          schemaVersion: "pragma.context-store-revision-record/v1",
          storeId: id,
          revision: 1,
          snapshotHash: snapshot.snapshotHash,
          parentRevision: null,
          author: "migration",
          summary: "Initialize revision history from context store v3.",
          createdAt: snapshot.createdAt,
        });
        pending = ContextStoreV4MigrationJournalSchema.parse({
          schemaVersion: "pragma.context-store-v4-migration/v1",
          storeId: id,
          sourceSchema: "pragma.context-store/v3",
          targetSchema: "pragma.context-store/v4",
          targetManifest: target,
          snapshot,
          record,
        });
        await writeJsonAtomic(
          join(storePath(id), "migration-backups", "store.v3.json"),
          latestLegacy.data,
        );
        await writeJsonAtomic(journalPath, pending);
      }
      if (pending.storeId !== id) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${id} has an invalid v4 migration journal.`,
        );
      }
      assertRevisionBundle(id, pending.targetManifest, pending.snapshot, pending.record);
      await persistRevision(id, pending.snapshot, pending.record);
      await writeJsonAtomic(manifestPath(id), pending.targetManifest);
      await rm(journalPath, { force: true });
      return pending.targetManifest;
    });

  const ensureSnapshotStorageV2 = async (id: string, current: ContextStore): Promise<void> => {
    const marker = async (): Promise<boolean> => {
      try {
        const parsed = ContextStoreSnapshotStorageMarkerSchema.parse(
          parseJson(await readFile(snapshotStorageMarkerPath(id), "utf8"), SNAPSHOT_STORAGE_MARKER),
        );
        return parsed.storeId === id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    if (await marker()) return;
    await withFileLock(join(storePath(id), ".snapshot-v2-migration.lock"), async () => {
      if (await marker()) return;
      const backupRoot = join(storePath(id), "migration-backups", "snapshot-storage-v1");
      const backupRevisions = join(backupRoot, "revisions");
      if (!(await pathExists(backupRevisions))) {
        await mkdir(backupRoot, { recursive: true, mode: 0o700 });
        await cp(revisionsRoot(id), backupRevisions, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
      }
      for (let revision = 1; revision <= current.contentRevision; revision += 1) {
        const path = snapshotPath(id, revision);
        const raw = parseJson(
          await readFile(path, "utf8"),
          `${id}/revisions/${revision}/snapshot.json`,
        );
        const migrated = ContextStoreSnapshotManifestV2Schema.safeParse(raw);
        if (migrated.success) {
          await materializeStoredSnapshot(id, migrated.data);
          continue;
        }
        const legacy = ContextStoreSnapshotSchema.parse(raw);
        assertSnapshotInvariant(id, legacy, {
          revision,
          ...(revision === current.contentRevision ? { snapshotHash: current.snapshotHash } : {}),
        });
        await writeJsonAtomic(path, await persistSnapshotManifest(id, legacy));
      }
      await writeJsonAtomic(
        snapshotStorageMarkerPath(id),
        ContextStoreSnapshotStorageMarkerSchema.parse({
          schemaVersion: "pragma.context-store-snapshot-storage/v2",
          storeId: id,
          migratedAt: new Date().toISOString(),
        }),
      );
      if (options.trashItem !== undefined) await options.trashItem(backupRoot);
    });
  };

  const readStore = async (id: string): Promise<ContextStore> => {
    try {
      await recoverRevisionTransaction(id);
      const raw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const current = ContextStoreSchema.safeParse(raw);
      if (current.success) {
        await rm(join(storePath(id), "v2-to-v3.json"), { force: true });
        await ensureSnapshotStorageV2(id, current.data);
        return current.data;
      }
      const legacyV2 = LegacyContextStoreV2Schema.safeParse(raw);
      const legacyV3 = LegacyContextStoreV3Schema.safeParse(raw);
      if (legacyV3.success) {
        const migrated = await migrateV3Store(id, legacyV3.data);
        await ensureSnapshotStorageV2(id, migrated);
        return migrated;
      }
      if (legacyV2.success) {
        const migrated = await migrateV3Store(id, await migrateV2Store(id, legacyV2.data));
        await ensureSnapshotStorageV2(id, migrated);
        return migrated;
      }
      const legacy = LegacyContextStoreV1Schema.safeParse(raw);
      if (legacy.success) {
        const migrated = await migrateFileStore(id, legacy.data);
        const current = await migrateV3Store(id, await migrateV2Store(id, migrated));
        await ensureSnapshotStorageV2(id, current);
        return current;
      }
      throw new ContextStoreStoreError(
        "config_invalid",
        `Context store ${id} uses an unsupported schema.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!(await pathExists(manifestPath(id)))) {
          throw new ContextStoreStoreError(
            "store_not_found",
            "The knowledge base no longer exists.",
          );
        }
        throw new ContextStoreStoreError(
          "source_unavailable",
          `Knowledge base ${id} could not finish its storage upgrade because a source is unavailable.`,
        );
      }
      if (error instanceof ContextStoreStoreError) throw error;
      if (error instanceof z.ZodError) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${id} has invalid JSON data.`,
        );
      }
      throw error;
    }
  };

  const finalizeRevisionTransaction = async (
    id: string,
    pending: z.infer<typeof ContextStoreRevisionJournalSchema>,
  ): Promise<ContextStore> => {
    assertRevisionBundle(id, pending.targetManifest, pending.snapshot, pending.record);
    assertRevisionTemporaryPath(storePath(id), pending.previousFilesPath, ".files.previous.");
    assertRevisionTemporaryPath(storePath(id), pending.stagedFilesPath, ".files.staged.");
    const live = contentRoot(id);
    if (await pathExists(pending.stagedFilesPath)) {
      if (await pathExists(live)) {
        if (await pathExists(pending.previousFilesPath)) {
          throw new ContextStoreStoreError(
            "config_invalid",
            `Knowledge base ${id} has ambiguous revision recovery state.`,
          );
        }
        await rename(live, pending.previousFilesPath);
      }
      await rename(pending.stagedFilesPath, live);
    } else if (!(await pathExists(live))) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} lost both staged and active revision files.`,
      );
    }
    await persistRevision(id, pending.snapshot, pending.record);
    await writeJsonAtomic(manifestPath(id), pending.targetManifest);
    await rm(pending.previousFilesPath, { recursive: true, force: true });
    await rm(join(storePath(id), "revision.json"), { force: true });
    return pending.targetManifest;
  };

  async function recoverRevisionTransaction(id: string): Promise<void> {
    const journalPath = join(storePath(id), "revision.json");
    let raw: unknown;
    try {
      raw = parseJson(await readFile(journalPath, "utf8"), `${id}/revision.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const pending = ContextStoreRevisionJournalSchema.safeParse(raw);
    if (!pending.success || pending.data.storeId !== id) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} has an invalid revision journal.`,
      );
    }
    await finalizeRevisionTransaction(id, pending.data);
  }

  const resolveStore = async (storeId: string) => {
    const current = await readStore(storeId);
    return {
      revision: createHash("sha256")
        .update(
          JSON.stringify({
            id: current.id,
            contentRevision: current.contentRevision,
            snapshotHash: current.snapshotHash,
            name: current.name,
            description: current.description,
          }),
        )
        .digest("hex"),
      name: current.name,
      store: fileStore(storeId),
    };
  };
  return {
    resolve: resolveStore,
    storePath,
    manifestPath,
    contentRoot,
    revisionRecordPath,
    revisionListStatePath,
    fileStoreAt,
    fileStore,
    withRevisionLock,
    withDraftPublicationLock,
    readRevisionListState,
    buildSnapshot,
    persistSnapshotManifest,
    readSnapshot,
    readStore,
    finalizeRevisionTransaction,
  };
}
