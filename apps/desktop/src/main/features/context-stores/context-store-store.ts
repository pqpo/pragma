import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import {
  access,
  cp,
  lstat,
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
import { withFileLock, type ExpertAgentContextStore } from "@pragma/core";
import { pragmaKnowledgeBaseEntryNameIssue } from "@pragma/shared";

import {
  ContextStoreContentMetadataSchema,
  ContextStoreChangeSetSchema,
  ContextStoreSchema,
  ContextStoreSnapshotSchema,
  CreateContextStoreSchema,
  type ContextStore,
  type ContextStoreContent,
  type ContextStoreContentMetadata,
  type ContextStoreChangeSet,
  type ContextStoreEntry,
  type ContextStoreImportInspection,
  type ContextStoreSnapshot,
  type CreateContextStore,
} from "../../../shared/contracts/index.ts";

const FILE_CONTENT_MAX_BYTES = 1_000_000;
const MIGRATION_READY_FILE = ".pragma-migration-ready.json";

const LegacyContextStoreV3Schema = z.object({
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

const LegacyContextStoreV4Schema = LegacyContextStoreV3Schema.extend({
  schemaVersion: z.literal("pragma.context-store/v4"),
  contentRevision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

const LegacyContextStoreSnapshotV1Schema = z.object({
  schemaVersion: z.literal("pragma.context-store-snapshot/v1"),
  storeId: z.string().uuid(),
  revision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.string().datetime(),
  directories: z.array(z.string()),
  files: ContextStoreSnapshotSchema.shape.files,
});

const LegacyContextStoreRevisionRecordSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-revision-record/v1"),
  storeId: z.string().uuid(),
  revision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  parentRevision: z.number().int().positive().nullable(),
  author: z.enum(["user", "import", "memory-initialization", "store-revision-agent", "migration"]),
  revisionJobId: z.string().uuid().optional(),
  summary: z.string().trim().min(1).max(2_000),
  createdAt: z.string().datetime(),
});

const LegacyContextStoreV1Schema = z.object({
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

const LegacyContextStoreV2Schema = z.object({
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

const ContextStoreMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v1"),
  targetSchema: z.literal("pragma.context-store/v2"),
  sourcePath: z.string().min(1),
  temporaryFiles: z.string().min(1),
  targetManifest: LegacyContextStoreV2Schema,
});

const ContextStoreMigrationReadySchema = z.object({
  schemaVersion: z.literal("pragma.context-store-migration-ready/v1"),
  storeId: z.string().uuid(),
});

const ContextStoreMetadataMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-metadata-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v2"),
  targetSchema: z.literal("pragma.context-store/v3"),
  targetManifest: LegacyContextStoreV3Schema,
});

const ContextStoreV4MigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-v4-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v3"),
  targetSchema: z.literal("pragma.context-store/v4"),
  targetManifest: LegacyContextStoreV4Schema,
  snapshot: LegacyContextStoreSnapshotV1Schema,
  record: LegacyContextStoreRevisionRecordSchema,
});

const ContextStoreRevisionJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-revision-journal/v1"),
  storeId: z.string().uuid(),
  previousFilesPath: z.string().min(1),
  stagedFilesPath: z.string().min(1),
  targetManifest: LegacyContextStoreV4Schema,
  snapshot: LegacyContextStoreSnapshotV1Schema,
  record: LegacyContextStoreRevisionRecordSchema,
});

const ContextStoreMutationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-mutation-journal/v1"),
  storeId: z.string().uuid(),
  previousFilesPath: z.string().min(1),
  stagedFilesPath: z.string().min(1),
  targetManifest: ContextStoreSchema,
  snapshot: ContextStoreSnapshotSchema,
});

const ContextStoreV5MigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-v5-migration/v1"),
  storeId: z.string().uuid(),
  targetManifest: ContextStoreSchema,
  legacyRevisionsPath: z.string().min(1),
});

type ContextStoreMigrationJournal = z.infer<typeof ContextStoreMigrationJournalSchema>;
type TrashItem = (path: string) => Promise<void>;

export interface ContextStoreStore {
  list(): Promise<ContextStore[]>;
  create(input: CreateContextStore): Promise<ContextStore>;
  inspectImport(sourcePath: string): Promise<ContextStoreImportInspection>;
  remove(storeId: string): Promise<void>;
  listEntries(storeId: string): Promise<readonly ContextStoreEntry[]>;
  createFolder(storeId: string, id: string): Promise<void>;
  createFile(
    storeId: string,
    id: string,
    content: string,
    metadata?: ContextStoreContentMetadata,
  ): Promise<ContextStoreContent>;
  updateFile(
    storeId: string,
    id: string,
    content: string,
    metadata: ContextStoreContentMetadata,
    expectedRevision: string,
  ): Promise<ContextStoreContent>;
  renameEntry(
    storeId: string,
    id: string,
    nextId: string,
    kind: "file" | "directory",
  ): Promise<void>;
  deleteEntry(storeId: string, id: string, kind: "file" | "directory"): Promise<void>;
  getContent(storeId: string, contentId: string): Promise<ContextStoreContent>;
  filesPath(storeId: string): Promise<string>;
  fingerprint(storeId: string): Promise<string>;
  createFromSnapshot(input: {
    readonly id?: string | undefined;
    readonly name: string;
    readonly description: string;
    readonly directories?: readonly string[] | undefined;
    readonly files: ContextStoreSnapshot["files"];
    readonly expectedSnapshotHash?: string | undefined;
  }): Promise<ContextStore>;
  getSnapshot(storeId: string): Promise<ContextStoreSnapshot>;
  applyChangeSet(changeSet: ContextStoreChangeSet): Promise<ContextStore>;
  replaceSnapshot(input: {
    readonly storeId: string;
    readonly baseSnapshotHash: string;
    readonly snapshotHash: string;
    readonly directories: readonly string[];
    readonly files: ContextStoreSnapshot["files"];
  }): Promise<ContextStore>;
  withMutationLock<T>(storeId: string, operation: () => Promise<T>): Promise<T>;
  resolve(storeId: string): Promise<{
    readonly revision: string;
    readonly name: string;
    readonly store: ExpertAgentContextStore;
  }>;
}

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
      | "store_referenced"
      | "legacy_note_unsupported",
    message: string,
  ) {
    super(message);
    this.name = "ContextStoreStoreError";
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ContextStoreStoreError("config_invalid", `${label} is not valid JSON.`);
  }
}

function assertSnapshotInvariant(
  id: string,
  snapshot: ContextStoreSnapshot,
  expected?: { readonly snapshotHash?: string },
): void {
  const computed = hashContextStoreSnapshotContent(snapshot.files, snapshot.directories);
  if (
    snapshot.storeId !== id ||
    (expected?.snapshotHash !== undefined && snapshot.snapshotHash !== expected.snapshotHash) ||
    snapshot.snapshotHash !== computed
  ) {
    throw new ContextStoreStoreError(
      "config_invalid",
      `Knowledge base ${id} has an inconsistent revision snapshot.`,
    );
  }
}

function assertLegacyRevisionBundle(
  id: string,
  manifest: z.infer<typeof LegacyContextStoreV4Schema>,
  snapshot: z.infer<typeof LegacyContextStoreSnapshotV1Schema>,
  record: z.infer<typeof LegacyContextStoreRevisionRecordSchema>,
): void {
  const computed = hashContextStoreSnapshotContent(snapshot.files, snapshot.directories);
  if (
    manifest.id !== id ||
    snapshot.storeId !== id ||
    snapshot.revision !== manifest.contentRevision ||
    snapshot.snapshotHash !== manifest.snapshotHash ||
    snapshot.snapshotHash !== computed ||
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

export function createContextStoreStore(options: {
  readonly storesPath: string;
  readonly isReferenced?: ((storeId: string) => Promise<boolean>) | undefined;
  readonly trashItem?: TrashItem | undefined;
  readonly onRemoved?: ((storeId: string) => Promise<void>) | undefined;
  readonly hasActiveDrafts?: ((storeId: string) => Promise<boolean>) | undefined;
  readonly migrateLegacyDraftReferences?:
    | ((
        storeId: string,
        readLegacySnapshot: (revision?: number) => Promise<ContextStoreSnapshot>,
      ) => Promise<void>)
    | undefined;
}): ContextStoreStore {
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
  const mutationLockPath = (id: string) => join(options.storesPath, ".locks", `${id}.lock`);
  const fileStoreAt = (rootDir: string) =>
    new FileSystemContextStore({
      rootDir,
      maxContextBytes: FILE_CONTENT_MAX_BYTES,
    });
  const fileStore = (id: string) => fileStoreAt(contentRoot(id));
  const withMutationLock = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const canonicalId = z.string().uuid().parse(id);
    return await withFileLock(mutationLockPath(canonicalId), operation);
  };
  const assertV5Migration = (
    id: string,
    migration: z.infer<typeof ContextStoreV5MigrationJournalSchema>,
    expectedManifest?: ContextStore,
  ): void => {
    if (
      migration.storeId !== id ||
      migration.targetManifest.id !== id ||
      resolve(migration.legacyRevisionsPath) !== resolve(revisionsRoot(id)) ||
      (expectedManifest !== undefined &&
        JSON.stringify(migration.targetManifest) !== JSON.stringify(expectedManifest))
    ) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} has an invalid v5 migration journal.`,
      );
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
    root = contentRoot(id),
    createdAt = new Date().toISOString(),
  ): Promise<ContextStoreSnapshot> => {
    const adapter = new FileSystemContextStore({
      rootDir: root,
      maxContextBytes: FILE_CONTENT_MAX_BYTES,
    });
    const listed = await adapter.listContext();
    if (!listed.ok) {
      throw new ContextStoreStoreError("source_unavailable", listed.error.message);
    }
    const files = await Promise.all(
      listed.value
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map(async (item) => {
          const read = await adapter.readContext({ id: item.id, offset: FILE_CONTENT_MAX_BYTES });
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
    const snapshotHash = hashContextStoreSnapshotContent(files, directories);
    return ContextStoreSnapshotSchema.parse({
      schemaVersion: "pragma.context-store-snapshot/v2",
      storeId: id,
      snapshotHash,
      createdAt,
      directories,
      files,
    });
  };

  const persistLegacyRevision = async (
    id: string,
    snapshot: z.infer<typeof LegacyContextStoreSnapshotV1Schema>,
    record: z.infer<typeof LegacyContextStoreRevisionRecordSchema>,
  ): Promise<void> => {
    if (
      snapshot.snapshotHash !==
      hashContextStoreSnapshotContent(snapshot.files, snapshot.directories)
    ) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} has an invalid legacy snapshot.`,
      );
    }
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
    await writeJsonAtomic(snapshotPath(id, snapshot.revision), snapshot);
    await writeJsonAtomic(revisionRecordPath(id, record.revision), record);
  };

  const migrateV3Store = async (
    id: string,
    legacy: z.infer<typeof LegacyContextStoreV3Schema>,
  ): Promise<z.infer<typeof LegacyContextStoreV4Schema>> =>
    await withFileLock(join(storePath(id), ".v4-migration.lock"), async () => {
      const latestRaw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const current = LegacyContextStoreV4Schema.safeParse(latestRaw);
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
        const currentSnapshot = await buildSnapshot(id, contentRoot(id), new Date().toISOString());
        const snapshot = LegacyContextStoreSnapshotV1Schema.parse({
          ...currentSnapshot,
          schemaVersion: "pragma.context-store-snapshot/v1",
          revision: 1,
        });
        const target = LegacyContextStoreV4Schema.parse({
          ...latestLegacy.data,
          schemaVersion: "pragma.context-store/v4",
          contentRevision: 1,
          snapshotHash: snapshot.snapshotHash,
        });
        const record = LegacyContextStoreRevisionRecordSchema.parse({
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
      assertLegacyRevisionBundle(id, pending.targetManifest, pending.snapshot, pending.record);
      await persistLegacyRevision(id, pending.snapshot, pending.record);
      await writeJsonAtomic(manifestPath(id), pending.targetManifest);
      await rm(journalPath, { force: true });
      return pending.targetManifest;
    });

  const readLegacySnapshot = async (
    id: string,
    revision: number,
  ): Promise<ContextStoreSnapshot> => {
    const legacy = LegacyContextStoreSnapshotV1Schema.parse(
      parseJson(
        await readFile(snapshotPath(id, revision), "utf8"),
        `${id}/revisions/${revision}/snapshot.json`,
      ),
    );
    if (
      legacy.storeId !== id ||
      legacy.snapshotHash !== hashContextStoreSnapshotContent(legacy.files, legacy.directories)
    ) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} has an inconsistent legacy snapshot ${revision}.`,
      );
    }
    return ContextStoreSnapshotSchema.parse({
      ...legacy,
      schemaVersion: "pragma.context-store-snapshot/v2",
      revision: undefined,
    });
  };

  const migrateV4Store = async (
    id: string,
    legacy: z.infer<typeof LegacyContextStoreV4Schema>,
  ): Promise<ContextStore> =>
    await withFileLock(join(storePath(id), ".v5-migration.lock"), async () => {
      const latestRaw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const current = ContextStoreSchema.safeParse(latestRaw);
      if (current.success) return current.data;
      const latestLegacy = LegacyContextStoreV4Schema.safeParse(latestRaw);
      if (!latestLegacy.success || latestLegacy.data.id !== legacy.id) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${id} has invalid schema v4 data.`,
        );
      }
      const currentSnapshot = await buildSnapshot(id, contentRoot(id), latestLegacy.data.updatedAt);
      if (currentSnapshot.snapshotHash !== latestLegacy.data.snapshotHash) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${id} current files do not match its latest v4 snapshot.`,
        );
      }
      await options.migrateLegacyDraftReferences?.(
        id,
        async (revision) =>
          await readLegacySnapshot(id, revision ?? latestLegacy.data.contentRevision),
      );
      const targetManifest = ContextStoreSchema.parse({
        ...latestLegacy.data,
        schemaVersion: "pragma.context-store/v5",
        contentRevision: undefined,
      });
      const journalPath = join(storePath(id), "v4-to-v5.json");
      let pending: z.infer<typeof ContextStoreV5MigrationJournalSchema> | undefined;
      try {
        pending = ContextStoreV5MigrationJournalSchema.parse(
          parseJson(await readFile(journalPath, "utf8"), `${id}/v4-to-v5.json`),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (pending === undefined) {
        pending = ContextStoreV5MigrationJournalSchema.parse({
          schemaVersion: "pragma.context-store-v5-migration/v1",
          storeId: id,
          targetManifest,
          legacyRevisionsPath: revisionsRoot(id),
        });
        await writeJsonAtomic(
          join(storePath(id), "migration-backups", "store.v4.json"),
          latestLegacy.data,
        );
        await writeJsonAtomic(journalPath, pending);
      }
      assertV5Migration(id, pending, targetManifest);
      await writeJsonAtomic(manifestPath(id), pending.targetManifest);
      await finishV5Migration(id, pending, targetManifest);
      return pending.targetManifest;
    });

  const finishV5Migration = async (
    id: string,
    pending?: z.infer<typeof ContextStoreV5MigrationJournalSchema>,
    expectedManifest?: ContextStore,
  ): Promise<void> => {
    const journalPath = join(storePath(id), "v4-to-v5.json");
    let migration = pending;
    if (migration === undefined) {
      try {
        migration = ContextStoreV5MigrationJournalSchema.parse(
          parseJson(await readFile(journalPath, "utf8"), `${id}/v4-to-v5.json`),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    assertV5Migration(id, migration, expectedManifest);
    if (await pathExists(migration.legacyRevisionsPath)) {
      if (options.trashItem !== undefined) await options.trashItem(migration.legacyRevisionsPath);
      else await rm(migration.legacyRevisionsPath, { recursive: true, force: true });
    }
    await rm(journalPath, { force: true });
  };

  const readStore = async (id: string): Promise<ContextStore> => {
    try {
      await recoverRevisionTransaction(id);
      await recoverMutationTransaction(id);
      const raw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const current = ContextStoreSchema.safeParse(raw);
      if (current.success) {
        await finishV5Migration(id, undefined, current.data);
        await rm(join(storePath(id), "v2-to-v3.json"), { force: true });
        return current.data;
      }
      const legacyV2 = LegacyContextStoreV2Schema.safeParse(raw);
      const legacyV3 = LegacyContextStoreV3Schema.safeParse(raw);
      const legacyV4 = LegacyContextStoreV4Schema.safeParse(raw);
      if (legacyV4.success) return await migrateV4Store(id, legacyV4.data);
      if (legacyV3.success)
        return await migrateV4Store(id, await migrateV3Store(id, legacyV3.data));
      if (legacyV2.success)
        return await migrateV4Store(
          id,
          await migrateV3Store(id, await migrateV2Store(id, legacyV2.data)),
        );
      const legacy = LegacyContextStoreV1Schema.safeParse(raw);
      if (legacy.success) {
        const migrated = await migrateFileStore(id, legacy.data);
        return await migrateV4Store(
          id,
          await migrateV3Store(id, await migrateV2Store(id, migrated)),
        );
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
  ): Promise<z.infer<typeof LegacyContextStoreV4Schema>> => {
    assertLegacyRevisionBundle(id, pending.targetManifest, pending.snapshot, pending.record);
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
    await persistLegacyRevision(id, pending.snapshot, pending.record);
    await writeJsonAtomic(manifestPath(id), pending.targetManifest);
    await rm(pending.previousFilesPath, { recursive: true, force: true });
    await rm(join(storePath(id), "revision.json"), { force: true });
    return pending.targetManifest;
  };

  const finalizeMutationTransaction = async (
    id: string,
    pending: z.infer<typeof ContextStoreMutationJournalSchema>,
  ): Promise<ContextStore> => {
    assertSnapshotInvariant(id, pending.snapshot, {
      snapshotHash: pending.targetManifest.snapshotHash,
    });
    assertRevisionTemporaryPath(storePath(id), pending.previousFilesPath, ".files.previous.");
    assertRevisionTemporaryPath(storePath(id), pending.stagedFilesPath, ".files.staged.");
    const live = contentRoot(id);
    if (await pathExists(pending.stagedFilesPath)) {
      if (await pathExists(live)) {
        if (await pathExists(pending.previousFilesPath)) {
          throw new ContextStoreStoreError(
            "config_invalid",
            `Knowledge base ${id} has ambiguous mutation recovery state.`,
          );
        }
        await rename(live, pending.previousFilesPath);
      }
      await rename(pending.stagedFilesPath, live);
    } else if (!(await pathExists(live))) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} lost both staged and active files.`,
      );
    }
    await writeJsonAtomic(manifestPath(id), pending.targetManifest);
    await rm(pending.previousFilesPath, { recursive: true, force: true });
    await rm(join(storePath(id), "mutation.json"), { force: true });
    return pending.targetManifest;
  };

  const commitSnapshot = async (input: {
    readonly current: ContextStore;
    readonly directories: ContextStoreSnapshot["directories"];
    readonly files: ContextStoreSnapshot["files"];
    readonly expectedSnapshotHash?: string | undefined;
  }): Promise<ContextStore> => {
    const id = input.current.id;
    const timestamp = new Date().toISOString();
    const stagedFilesPath = join(storePath(id), `.files.staged.${randomUUID()}`);
    const previousFilesPath = join(storePath(id), `.files.previous.${randomUUID()}`);
    await mkdir(stagedFilesPath, { recursive: true, mode: 0o700 });
    try {
      await materializeSnapshot(stagedFilesPath, {
        directories: input.directories,
        files: input.files,
      });
      const snapshot = await buildSnapshot(id, stagedFilesPath, timestamp);
      if (
        input.expectedSnapshotHash !== undefined &&
        snapshot.snapshotHash !== input.expectedSnapshotHash
      ) {
        throw new ContextStoreStoreError(
          "config_invalid",
          "The imported knowledge-base snapshot does not match its declared hash.",
        );
      }
      const targetManifest = ContextStoreSchema.parse({
        ...input.current,
        snapshotHash: snapshot.snapshotHash,
        updatedAt: timestamp,
      });
      const pending = ContextStoreMutationJournalSchema.parse({
        schemaVersion: "pragma.context-store-mutation-journal/v1",
        storeId: id,
        previousFilesPath,
        stagedFilesPath,
        targetManifest,
        snapshot,
      });
      await writeJsonAtomic(join(storePath(id), "mutation.json"), pending);
      return await finalizeMutationTransaction(id, pending);
    } catch (error) {
      if (!(await pathExists(join(storePath(id), "mutation.json")))) {
        await rm(stagedFilesPath, { recursive: true, force: true });
      }
      throw error;
    }
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

  async function recoverMutationTransaction(id: string): Promise<void> {
    const journalPath = join(storePath(id), "mutation.json");
    let raw: unknown;
    try {
      raw = parseJson(await readFile(journalPath, "utf8"), `${id}/mutation.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const pending = ContextStoreMutationJournalSchema.safeParse(raw);
    if (!pending.success || pending.data.storeId !== id) {
      throw new ContextStoreStoreError(
        "config_invalid",
        `Knowledge base ${id} has an invalid mutation journal.`,
      );
    }
    await finalizeMutationTransaction(id, pending.data);
  }

  const mutateCurrentState = async <T>(
    id: string,
    operation: (stagedRoot: string, currentRoot: string) => Promise<T>,
  ): Promise<T> =>
    await withMutationLock(id, async () => {
      const current = await readStore(id);
      const stagedFilesPath = join(storePath(id), `.files.staged.${randomUUID()}`);
      const previousFilesPath = join(storePath(id), `.files.previous.${randomUUID()}`);
      await cp(contentRoot(id), stagedFilesPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      let result: T;
      try {
        result = await operation(stagedFilesPath, contentRoot(id));
      } catch (error) {
        await rm(stagedFilesPath, { recursive: true, force: true });
        throw error;
      }
      const timestamp = new Date().toISOString();
      const snapshot = await buildSnapshot(id, stagedFilesPath, timestamp);
      if (snapshot.snapshotHash === current.snapshotHash) {
        await rm(stagedFilesPath, { recursive: true, force: true });
        return result;
      }
      const targetManifest = ContextStoreSchema.parse({
        ...current,
        snapshotHash: snapshot.snapshotHash,
        updatedAt: timestamp,
      });
      const pending = ContextStoreMutationJournalSchema.parse({
        schemaVersion: "pragma.context-store-mutation-journal/v1",
        storeId: id,
        previousFilesPath,
        stagedFilesPath,
        targetManifest,
        snapshot,
      });
      try {
        await writeJsonAtomic(join(storePath(id), "mutation.json"), pending);
        await finalizeMutationTransaction(id, pending);
        return result;
      } catch (error) {
        if (!(await pathExists(join(storePath(id), "mutation.json")))) {
          await rm(stagedFilesPath, { recursive: true, force: true });
        }
        throw error;
      }
    });

  const readLegacyCatalogEntry = async (id: string): Promise<ContextStore | undefined> => {
    try {
      const raw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const legacy = LegacyContextStoreV1Schema.safeParse(raw);
      if (!legacy.success || legacy.data.type === "note") return undefined;
      const legacyV3 = LegacyContextStoreV3Schema.parse({
        schemaVersion: "pragma.context-store/v3",
        id: legacy.data.id,
        name: legacy.data.name,
        description: legacy.data.description,
        type: "file",
        status: "needs_attention",
        source: { origin: "migrated" },
        createdAt: legacy.data.createdAt,
        updatedAt: legacy.data.updatedAt,
      });
      return ContextStoreSchema.parse({
        ...legacyV3,
        schemaVersion: "pragma.context-store/v5",
        snapshotHash: hashContextStoreSnapshotContent([], []),
      });
    } catch {
      return undefined;
    }
  };

  const resolveEntryAtRoot = async (
    root: string,
    id: string,
    kind: "file" | "directory",
    mustExist: boolean,
  ): Promise<string> => {
    const normalized = normalizeEntryId(id, kind);
    const target = resolve(root, ...normalized.split("/"));
    assertInsideRoot(root, target);
    await assertNoSymlinkAncestors(root, dirname(target));
    if (mustExist) {
      let stats;
      try {
        stats = await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ContextStoreStoreError("content_not_found", `Entry not found: ${normalized}`);
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw new ContextStoreStoreError("invalid_entry", "Symbolic links are not supported.");
      }
      if ((kind === "file" && !stats.isFile()) || (kind === "directory" && !stats.isDirectory())) {
        throw new ContextStoreStoreError(
          "invalid_entry",
          `Entry type does not match: ${normalized}`,
        );
      }
    }
    return target;
  };

  const toContent = (value: {
    readonly id: string;
    readonly content: string;
    readonly metadata: ContextStoreContentMetadata;
    readonly revision?: string | undefined;
    readonly etag?: string | undefined;
    readonly sizeBytes?: number | undefined;
  }): ContextStoreContent => ({
    id: value.id,
    content: value.content,
    metadata: value.metadata,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.etag === undefined ? {} : { etag: value.etag }),
    ...(value.sizeBytes === undefined ? {} : { sizeBytes: value.sizeBytes }),
    truncated: false,
  });

  return {
    async withMutationLock(storeId, operation) {
      return await withMutationLock(storeId, operation);
    },

    async list(): Promise<ContextStore[]> {
      let directories;
      try {
        directories = (await readdir(options.storesPath, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith("."),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const stores = await Promise.all(
        directories.map(async (entry) => {
          try {
            return await readStore(entry.name);
          } catch (error) {
            if (error instanceof ContextStoreStoreError) {
              if (error.code === "legacy_note_unsupported") return undefined;
              const legacy = await readLegacyCatalogEntry(entry.name);
              if (legacy !== undefined) return legacy;
              if (error.code === "config_invalid" || error.code === "source_unavailable") {
                return undefined;
              }
            }
            throw error;
          }
        }),
      );
      return stores
        .filter((store): store is ContextStore => store !== undefined)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async create(input: CreateContextStore): Promise<ContextStore> {
      const parsed = CreateContextStoreSchema.parse(input);
      if (parsed.mode === "import") {
        const inspection = await inspectMarkdownSource(parsed.sourcePath);
        assertSourceDoesNotContainStorage(inspection.sourcePath, options.storesPath);
        if (inspection.markdownFiles === 0) {
          throw new ContextStoreStoreError(
            "source_unavailable",
            "The selected folder does not contain any Markdown files.",
          );
        }
      }
      const timestamp = new Date().toISOString();
      const id = randomUUID();
      const targetPath = storePath(id);
      const temporaryPath = join(options.storesPath, `.${id}.${randomUUID()}.tmp`);
      await mkdir(join(temporaryPath, "files"), { recursive: true, mode: 0o700 });
      try {
        if (parsed.mode === "import") {
          await copyMarkdownTree(parsed.sourcePath, join(temporaryPath, "files"));
        }
        const snapshot = await buildSnapshot(id, join(temporaryPath, "files"), timestamp);
        const store = ContextStoreSchema.parse({
          schemaVersion: "pragma.context-store/v5",
          id,
          name: parsed.name,
          description: parsed.description,
          type: "file",
          status: "ready",
          source: { origin: parsed.mode === "blank" ? "created" : "copied" },
          snapshotHash: snapshot.snapshotHash,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await writeFile(join(temporaryPath, "store.json"), `${JSON.stringify(store, null, 2)}\n`, {
          mode: 0o600,
        });
        await mkdir(options.storesPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
        return store;
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    },

    async inspectImport(sourcePath) {
      return await inspectMarkdownSource(sourcePath);
    },

    async remove(storeId: string): Promise<void> {
      const id = z.string().uuid().parse(storeId);
      await withMutationLock(id, async () => {
        if (!(await pathExists(storePath(id)))) {
          throw new ContextStoreStoreError("store_not_found", `Knowledge base not found: ${id}`);
        }
        if (await options.isReferenced?.(id)) {
          throw new ContextStoreStoreError(
            "store_referenced",
            "This knowledge base is mounted by one or more Experts. Remove it before deleting.",
          );
        }
        if (await options.hasActiveDrafts?.(id)) {
          throw new ContextStoreStoreError(
            "store_referenced",
            "Resolve or delete this knowledge base's update tasks before deleting it.",
          );
        }
        if (options.trashItem !== undefined) await options.trashItem(storePath(id));
        else await rm(storePath(id), { recursive: true, force: true });
        await options.onRemoved?.(id);
      });
    },

    async listEntries(storeId) {
      await readStore(storeId);
      return await collectManagedEntries(contentRoot(storeId));
    },

    async createFolder(storeId, id) {
      assertManagedEntryName(id, "directory");
      await mutateCurrentState(storeId, async (stagedRoot) => {
        const target = await resolveEntryAtRoot(stagedRoot, id, "directory", false);
        try {
          await access(target);
          throw new ContextStoreStoreError("content_exists", `Entry already exists: ${id}`);
        } catch (error) {
          if (
            error instanceof ContextStoreStoreError ||
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          ) {
            throw error;
          }
        }
        const created = await mkdir(target, { recursive: true, mode: 0o700 });
        if (created === undefined) {
          throw new ContextStoreStoreError("content_exists", `Entry already exists: ${id}`);
        }
        assertInsideRoot(await realpath(stagedRoot), await realpath(target));
      });
    },

    async createFile(storeId, id, content, metadata) {
      assertManagedEntryName(id, "file");
      return await mutateCurrentState(storeId, async (stagedRoot) => {
        await resolveEntryAtRoot(stagedRoot, id, "file", false);
        const result = await fileStoreAt(stagedRoot).addContext({
          id,
          content,
          metadata: toCoreMetadata(
            metadata ??
              ContextStoreContentMetadataSchema.parse({
                description: id.split("/").at(-1)?.replace(/\.md$/i, ""),
                trigger: "manual",
                priority: "normal",
              }),
          ),
        });
        if (!result.ok) {
          throw new ContextStoreStoreError(
            result.error.code === "context_already_exists" ? "content_exists" : "invalid_entry",
            result.error.message,
          );
        }
        return toContent(result.value);
      });
    },

    async updateFile(storeId, id, content, metadata, expectedRevision) {
      return await mutateCurrentState(storeId, async (stagedRoot, currentRoot) => {
        const currentPath = await resolveEntryAtRoot(currentRoot, id, "file", true);
        const currentDetails = await stat(currentPath, { bigint: true });
        if (`${currentDetails.mtimeNs}:${currentDetails.size}` !== expectedRevision) {
          throw new ContextStoreStoreError("revision_conflict", `Context revision conflict: ${id}`);
        }
        await resolveEntryAtRoot(stagedRoot, id, "file", true);
        const result = await fileStoreAt(stagedRoot).editContext({
          id,
          mode: "replace",
          content,
          metadata: toCoreMetadata(metadata),
        });
        if (!result.ok) {
          throw new ContextStoreStoreError(
            result.error.code === "context_conflict"
              ? "revision_conflict"
              : result.error.code === "context_not_found"
                ? "content_not_found"
                : "invalid_entry",
            result.error.message,
          );
        }
        return toContent(result.value);
      });
    },

    async renameEntry(storeId, id, nextId, kind) {
      const currentName = entryNameFromId(id, kind);
      const nextName = entryNameFromId(nextId, kind);
      if (currentName !== nextName) assertManagedEntryName(nextId, kind);
      await mutateCurrentState(storeId, async (stagedRoot) => {
        const source = await resolveEntryAtRoot(stagedRoot, id, kind, true);
        const target = await resolveEntryAtRoot(stagedRoot, nextId, kind, false);
        if (kind === "directory" && (target === source || target.startsWith(`${source}${sep}`))) {
          throw new ContextStoreStoreError(
            "invalid_entry",
            "A directory cannot be moved inside itself.",
          );
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        try {
          await access(target);
          throw new ContextStoreStoreError("content_exists", `Entry already exists: ${nextId}`);
        } catch (error) {
          if (
            error instanceof ContextStoreStoreError ||
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          ) {
            throw error;
          }
        }
        await rename(source, target);
      });
    },

    async deleteEntry(storeId, id, kind) {
      await mutateCurrentState(storeId, async (stagedRoot) => {
        const target = await resolveEntryAtRoot(stagedRoot, id, kind, true);
        if (options.trashItem !== undefined) await options.trashItem(target);
        else await rm(target, { recursive: kind === "directory", force: false });
      });
    },

    async getContent(storeId: string, contentId: string): Promise<ContextStoreContent> {
      await readStore(storeId);
      const result = await fileStore(storeId).readContext({
        id: contentId,
        offset: FILE_CONTENT_MAX_BYTES,
      });
      if (!result.ok) {
        throw new ContextStoreStoreError(
          result.error.code === "context_not_found" ? "content_not_found" : "source_unavailable",
          result.error.message,
        );
      }
      if (result.value.contentRange.truncated) {
        throw new ContextStoreStoreError(
          "source_unavailable",
          "Markdown files larger than 1 MB cannot be edited.",
        );
      }
      return {
        id: result.value.id,
        content: result.value.content,
        metadata: result.value.metadata,
        ...(result.value.revision === undefined ? {} : { revision: result.value.revision }),
        ...(result.value.etag === undefined ? {} : { etag: result.value.etag }),
        ...(result.value.sizeBytes === undefined ? {} : { sizeBytes: result.value.sizeBytes }),
        truncated: result.value.contentRange.truncated,
      };
    },

    async filesPath(storeId) {
      await readStore(storeId);
      return contentRoot(storeId);
    },

    async createFromSnapshot(input) {
      const timestamp = new Date().toISOString();
      const id = input.id === undefined ? randomUUID() : z.string().uuid().parse(input.id);
      const files = ContextStoreSnapshotSchema.shape.files.parse(input.files);
      const directories = ContextStoreSnapshotSchema.shape.directories.parse(
        input.directories ?? [],
      );
      const targetPath = storePath(id);
      const temporaryPath = join(options.storesPath, `.${id}.${randomUUID()}.tmp`);
      const temporaryFiles = join(temporaryPath, "files");
      await mkdir(temporaryFiles, { recursive: true, mode: 0o700 });
      try {
        await materializeSnapshot(temporaryFiles, { directories, files });
        const snapshot = await buildSnapshot(id, temporaryFiles, timestamp);
        if (
          input.expectedSnapshotHash !== undefined &&
          snapshot.snapshotHash !== input.expectedSnapshotHash
        ) {
          throw new ContextStoreStoreError(
            "config_invalid",
            "The imported knowledge-base snapshot does not match its declared hash.",
          );
        }
        const store = ContextStoreSchema.parse({
          schemaVersion: "pragma.context-store/v5",
          id,
          name: input.name,
          description: input.description,
          type: "file",
          status: "ready",
          source: { origin: "created" },
          snapshotHash: snapshot.snapshotHash,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await writeJsonAtomic(join(temporaryPath, "store.json"), store);
        await mkdir(options.storesPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
        return store;
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    },

    async getSnapshot(storeId) {
      const current = await readStore(storeId);
      const snapshot = await buildSnapshot(storeId, contentRoot(storeId), current.updatedAt);
      assertSnapshotInvariant(storeId, snapshot, { snapshotHash: current.snapshotHash });
      return snapshot;
    },

    async applyChangeSet(input) {
      const changeSet = ContextStoreChangeSetSchema.parse(input);
      return await withMutationLock(changeSet.storeId, async () => {
        const current = await readStore(changeSet.storeId);
        if (current.snapshotHash !== changeSet.baseSnapshotHash) {
          throw new ContextStoreStoreError(
            "revision_conflict",
            "The knowledge base changed after this revision was prepared.",
          );
        }
        const base = await this.getSnapshot(changeSet.storeId);
        const files = new Map(base.files.map((file) => [file.id, file]));
        for (const operation of changeSet.operations) {
          if (operation.operation === "delete") {
            if (!files.delete(operation.id)) {
              throw new ContextStoreStoreError(
                "content_not_found",
                `Cannot delete missing knowledge file: ${operation.id}`,
              );
            }
          } else if (operation.operation === "rename") {
            const existing = files.get(operation.id);
            if (existing === undefined) {
              throw new ContextStoreStoreError(
                "content_not_found",
                `Cannot rename missing knowledge file: ${operation.id}`,
              );
            }
            if (files.has(operation.nextId)) {
              throw new ContextStoreStoreError(
                "content_exists",
                `Cannot rename over an existing knowledge file: ${operation.nextId}`,
              );
            }
            files.delete(operation.id);
            files.set(operation.nextId, { ...existing, id: operation.nextId });
          } else {
            files.set(operation.id, {
              id: operation.id,
              content: operation.content,
              metadata: operation.metadata,
            });
          }
        }
        return await commitSnapshot({
          current,
          directories: base.directories,
          files: [...files.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
        });
      });
    },

    async replaceSnapshot(input) {
      const storeId = z.string().uuid().parse(input.storeId);
      const baseSnapshotHash = z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(input.baseSnapshotHash);
      const expectedSnapshotHash = z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(input.snapshotHash);
      const directories = ContextStoreSnapshotSchema.shape.directories.parse(input.directories);
      const files = ContextStoreSnapshotSchema.shape.files.parse(input.files);
      return await withMutationLock(storeId, async () => {
        const current = await readStore(storeId);
        if (current.snapshotHash !== baseSnapshotHash) {
          throw new ContextStoreStoreError(
            "revision_conflict",
            "The knowledge base changed after this revision was prepared.",
          );
        }
        if (current.snapshotHash === expectedSnapshotHash) return current;
        return await commitSnapshot({
          current,
          directories,
          files,
          expectedSnapshotHash,
        });
      });
    },

    async fingerprint(storeId) {
      const store = await readStore(storeId);
      const hash = createHash("sha256");
      hash.update(
        JSON.stringify({
          schemaVersion: store.schemaVersion,
          name: store.name,
          description: store.description,
        }),
      );
      const visit = async (directory: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          const id = relative(contentRoot(storeId), path).split(sep).join("/");
          hash.update(entry.isDirectory() ? `d:${id}\0` : `f:${id}\0`);
          if (entry.isDirectory()) await visit(path);
          else if (entry.isFile()) hash.update(await readFile(path));
        }
      };
      await visit(contentRoot(storeId));
      return hash.digest("hex");
    },

    async resolve(storeId) {
      const current = await readStore(storeId);
      return {
        revision: createHash("sha256")
          .update(
            JSON.stringify({
              id: current.id,
              schemaVersion: current.schemaVersion,
              name: current.name,
            }),
          )
          .digest("hex"),
        name: current.name,
        store: fileStore(storeId),
      };
    },
  };
}

function normalizeEntryId(id: string, kind: "file" | "directory"): string {
  const portable = id.trim().replaceAll("\\", "/");
  const normalized = portable.replace(/\/+$/g, "");
  if (
    normalized.length === 0 ||
    isAbsolute(id) ||
    portable.startsWith("/") ||
    /^[a-z]:/i.test(portable) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ContextStoreStoreError(
      "invalid_entry",
      "Entry path must stay inside the knowledge base.",
    );
  }
  if (kind === "file" && extname(normalized).toLowerCase() !== ".md") {
    throw new ContextStoreStoreError(
      "invalid_entry",
      "Knowledge base files must use the .md extension.",
    );
  }
  return normalized;
}

function entryNameFromId(id: string, kind: "file" | "directory"): string {
  const segment = id.replaceAll("\\", "/").replace(/\/+$/u, "").split("/").at(-1) ?? "";
  return kind === "file" ? segment.replace(/\.md$/iu, "") : segment;
}

function assertManagedEntryName(id: string, kind: "file" | "directory"): void {
  const issue = pragmaKnowledgeBaseEntryNameIssue(entryNameFromId(id, kind));
  if (issue === undefined) return;
  throw new ContextStoreStoreError(
    "invalid_entry",
    `Knowledge base ${kind === "file" ? "file" : "folder"} name is invalid (${issue}).`,
  );
}

function assertInsideRoot(root: string, target: string): void {
  const path = relative(resolve(root), target);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new ContextStoreStoreError("invalid_entry", "Entry path escapes the knowledge base.");
  }
}

function assertSourceDoesNotContainStorage(sourcePath: string, storesPath: string): void {
  const source = resolve(sourcePath);
  const storage = resolve(storesPath);
  if (source === storage || storage.startsWith(`${source}${sep}`)) {
    throw new ContextStoreStoreError(
      "invalid_entry",
      "The Pragma data directory cannot be imported as a knowledge base.",
    );
  }
}

async function assertNoSymlinkAncestors(root: string, parent: string): Promise<void> {
  const rootPath = resolve(root);
  const parentPath = resolve(parent);
  assertInsideRoot(rootPath, parentPath);
  const segments = relative(rootPath, parentPath).split(sep).filter(Boolean);
  let current = rootPath;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        throw new ContextStoreStoreError("invalid_entry", "Symbolic links are not supported.");
      }
      if (!details.isDirectory()) {
        throw new ContextStoreStoreError(
          "invalid_entry",
          `Entry parent is not a directory: ${relative(rootPath, current)}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function inspectMarkdownSource(sourcePath: string): Promise<ContextStoreImportInspection> {
  let sourceRoot: string;
  try {
    sourceRoot = await realpath(sourcePath);
    if (!(await stat(sourceRoot)).isDirectory()) {
      throw new ContextStoreStoreError(
        "source_unavailable",
        "The selected source is not a folder.",
      );
    }
    await access(sourceRoot, fsConstants.R_OK);
  } catch (error) {
    if (error instanceof ContextStoreStoreError) throw error;
    throw new ContextStoreStoreError("source_unavailable", "The selected folder is not readable.");
  }
  const counts = { markdownFiles: 0, ignoredFiles: 0, totalBytes: 0 };
  await walkSource(sourceRoot, async (path, entry) => {
    if (entry.isSymbolicLink()) {
      counts.ignoredFiles += 1;
      return;
    }
    if (!entry.isFile()) return;
    if (extname(entry.name).toLowerCase() !== ".md") {
      counts.ignoredFiles += 1;
      return;
    }
    const details = await stat(path);
    counts.markdownFiles += 1;
    counts.totalBytes += details.size;
  });
  return { sourcePath: sourceRoot, ...counts };
}

async function copyMarkdownTree(sourcePath: string, targetPath: string): Promise<void> {
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
    if (content.byteLength > FILE_CONTENT_MAX_BYTES) {
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

async function walkSource(
  root: string,
  visit: (path: string, entry: Dirent<string>) => Promise<void>,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    await visit(path, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await walkSource(path, visit);
  }
}

function toCoreMetadata(metadata: ContextStoreContentMetadata) {
  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: metadata.trigger,
    ...(metadata.trustLevel === undefined ? {} : { trustLevel: metadata.trustLevel }),
    ...(metadata.sensitivity === undefined ? {} : { sensitivity: metadata.sensitivity }),
    priority: metadata.priority,
  };
}

export function hashContextStoreSnapshotContent(
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

async function materializeSnapshot(
  root: string,
  snapshot: Pick<ContextStoreSnapshot, "directories" | "files">,
): Promise<void> {
  for (const directory of snapshot.directories.toSorted()) {
    await mkdir(resolve(root, ...directory.split("/")), { recursive: true, mode: 0o700 });
  }
  const adapter = new FileSystemContextStore({
    rootDir: root,
    maxContextBytes: FILE_CONTENT_MAX_BYTES,
  });
  for (const file of snapshot.files) {
    const result = await adapter.addContext({
      id: file.id,
      content: file.content,
      metadata: toCoreMetadata(file.metadata),
    });
    if (!result.ok) {
      throw new ContextStoreStoreError("invalid_entry", result.error.message);
    }
  }
}

async function collectManagedEntries(root: string): Promise<ContextStoreEntry[]> {
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
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

async function readMigrationJournal(
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

async function readContextStoreMetadataMigrationJournal(
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

async function hasMigrationReadyMarker(path: string, storeId: string): Promise<boolean> {
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

function assertMigrationTemporaryPath(storePath: string, temporaryFiles: string): void {
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

function assertRevisionTemporaryPath(
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
