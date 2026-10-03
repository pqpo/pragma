export { ContextStoreStoreError, hashSnapshotContent } from "@pragma/local-host/resources";
import {
  createLocalHostContextStoreReader,
  ContextStoreStoreError,
  ContextStoreRevisionJournalSchema,
  parseJson,
  writeJsonAtomic,
  pathExists,
  assertSnapshotInvariant,
  hashSnapshotContent,
  LegacyContextStoreV1Schema,
  LegacyContextStoreV3Schema,
  SNAPSHOT_STORAGE_MARKER,
  collectManagedEntries,
  copyMarkdownTree,
  walkSource,
} from "@pragma/local-host/resources";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
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
import { type ExpertAgentContextStore } from "@pragma/core";
import { pragmaKnowledgeBaseEntryNameIssue } from "@pragma/shared";
import {
  CONTEXT_STORE_FILE_MAX_BYTES,
  ContextStoreContentMetadataSchema,
  ContextStoreChangeSetSchema,
  ContextStoreRevisionRecordSchema,
  ContextStoreSchema,
  ContextStoreSnapshotSchema,
  CreateContextStoreSchema,
  type ContextStore,
  type ContextStoreContent,
  type ContextStoreContentMetadata,
  type ContextStoreChangeSet,
  type ContextStoreEntry,
  type ContextStoreImportInspection,
  type ContextStoreRevisionRecord,
  type ContextStoreSnapshot,
  type CreateContextStore,
} from "../../../shared/contracts/index.ts";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";
import { classifyDesktopContextResource } from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import { isGitMetadataPath } from "../../../shared/git-metadata-path.ts";
type TrashItem = (path: string) => Promise<void>;
export interface ContextStoreStore {
  list(): Promise<ContextStore[]>;
  get(storeId: string): Promise<ContextStore>;
  /** Includes persisted stores with invalid or unavailable configuration. */
  exists(storeId: string): Promise<boolean>;
  create(input: CreateContextStore): Promise<ContextStore>;
  inspectImport(sourcePath: string): Promise<ContextStoreImportInspection>;
  remove(
    storeId: string,
    expected?:
      | {
          readonly revision: number;
          readonly snapshotHash: string;
        }
      | undefined,
  ): Promise<void>;
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
    readonly author: ContextStoreRevisionRecord["author"];
    readonly summary: string;
    readonly revisionJobId?: string | undefined;
    readonly expectedSnapshotHash?: string | undefined;
  }): Promise<ContextStore>;
  getSnapshot(storeId: string, revision?: number): Promise<ContextStoreSnapshot>;
  applyChangeSet(
    changeSet: ContextStoreChangeSet,
    author: ContextStoreRevisionRecord["author"],
    revisionJobId?: string | undefined,
  ): Promise<ContextStore>;
  appendSnapshot(
    input: {
      readonly storeId: string;
      readonly baseRevision: number;
      readonly baseSnapshotHash: string;
      readonly snapshotHash: string;
      readonly directories: readonly string[];
      readonly files: ContextStoreSnapshot["files"];
      readonly summary: string;
      readonly name?: string | undefined;
      readonly description?: string | undefined;
    },
    author: ContextStoreRevisionRecord["author"],
  ): Promise<ContextStore>;
  history(storeId: string): Promise<readonly ContextStoreRevisionRecord[]>;
  deleteRevisionRecord(
    storeId: string,
    revision: number,
    expectedSnapshotHash: string,
  ): Promise<void>;
  withRevisionLock<T>(storeId: string, operation: () => Promise<T>): Promise<T>;
  withDraftPublicationLock<T>(storeId: string, operation: () => Promise<T>): Promise<T>;
  resolve(storeId: string): Promise<{
    readonly revision: string;
    readonly name: string;
    readonly store: ExpertAgentContextStore;
  }>;
}
export async function withContextStoreRevisionLocks<T>(
  stores: Pick<ContextStoreStore, "withRevisionLock"> | undefined,
  storeIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const uniqueStoreIds = [...new Set(storeIds)].toSorted();
  const withLock = async (index: number): Promise<T> => {
    const storeId = uniqueStoreIds[index];
    if (storeId === undefined) return await operation();
    if (stores === undefined) {
      throw new Error(`Knowledge Store is unavailable: ${storeId}`);
    }
    return await stores.withRevisionLock(storeId, async () => await withLock(index + 1));
  };
  return await withLock(0);
}
export function createContextStoreStore(options: {
  readonly storesPath: string;
  readonly project?: PragmaProjectStore | undefined;
  readonly externalResources?: (() => readonly PragmaResource[]) | undefined;
  readonly isReferenced?: ((storeId: string) => Promise<boolean>) | undefined;
  readonly trashItem?: TrashItem | undefined;
  readonly onRemoved?: ((storeId: string) => Promise<void>) | undefined;
  readonly hasUnmergedRevisionDrafts?: ((storeId: string) => Promise<boolean>) | undefined;
  readonly removeMissionMounts?: ((storeId: string) => Promise<void>) | undefined;
  readonly hasMissionReferences?: ((storeId: string) => Promise<boolean>) | undefined;
  readonly onPublished?: ((storeId: string) => void) | undefined;
}): ContextStoreStore {
  const reader = createLocalHostContextStoreReader(options);
  const {
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
  } = reader;
  const deletionBindings = async (id: string) => {
    const snapshot = await options.project?.get();
    const resources = [...(snapshot?.resources ?? []), ...(options.externalResources?.() ?? [])];
    const dependencies = referencedPragmaResourceRefs(resources);
    const refs = resources
      .filter((resource) => classifyDesktopContextResource(resource) === id)
      .map(canonicalPragmaResourceRef);
    if (refs.some((ref) => dependencies.has(ref))) {
      throw new ContextStoreStoreError(
        "expert_referenced",
        "This knowledge base is mounted by an Expert or Expert Team. Remove those dependencies before deleting it.",
      );
    }
    return {
      snapshot,
      refs:
        snapshot?.resources
          .filter((resource) => classifyDesktopContextResource(resource) === id)
          .map(canonicalPragmaResourceRef) ?? [],
    };
  };
  const commitSnapshotRevision = async (input: {
    readonly current: ContextStore;
    readonly directories: ContextStoreSnapshot["directories"];
    readonly files: ContextStoreSnapshot["files"];
    readonly author: ContextStoreRevisionRecord["author"];
    readonly summary: string;
    readonly revisionJobId?: string | undefined;
    readonly expectedSnapshotHash?: string | undefined;
    readonly name?: string | undefined;
    readonly description?: string | undefined;
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
      const snapshot = await buildSnapshot(
        id,
        input.current.contentRevision + 1,
        stagedFilesPath,
        timestamp,
      );
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
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        contentRevision: snapshot.revision,
        snapshotHash: snapshot.snapshotHash,
        updatedAt: timestamp,
      });
      const record = ContextStoreRevisionRecordSchema.parse({
        schemaVersion: "pragma.context-store-revision-record/v1",
        storeId: id,
        revision: snapshot.revision,
        snapshotHash: snapshot.snapshotHash,
        parentRevision: input.current.contentRevision,
        author: input.author,
        ...(input.revisionJobId === undefined ? {} : { revisionJobId: input.revisionJobId }),
        summary: input.summary,
        createdAt: timestamp,
      });
      const pending = ContextStoreRevisionJournalSchema.parse({
        schemaVersion: "pragma.context-store-revision-journal/v1",
        storeId: id,
        previousFilesPath,
        stagedFilesPath,
        targetManifest,
        snapshot,
        record,
      });
      await writeJsonAtomic(join(storePath(id), "revision.json"), pending);
      const committed = await finalizeRevisionTransaction(id, pending);
      options.onPublished?.(id);
      return committed;
    } catch (error) {
      if (!(await pathExists(join(storePath(id), "revision.json")))) {
        await rm(stagedFilesPath, { recursive: true, force: true });
      }
      throw error;
    }
  };
  const mutateCurrentState = async <T>(
    id: string,
    summary: string,
    operation: (stagedRoot: string, currentRoot: string) => Promise<T>,
  ): Promise<T> =>
    await withRevisionLock(id, async () => {
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
      const snapshot = await buildSnapshot(
        id,
        current.contentRevision + 1,
        stagedFilesPath,
        timestamp,
      );
      if (snapshot.snapshotHash === current.snapshotHash) {
        await rm(stagedFilesPath, { recursive: true, force: true });
        return result;
      }
      const targetManifest = ContextStoreSchema.parse({
        ...current,
        contentRevision: snapshot.revision,
        snapshotHash: snapshot.snapshotHash,
        updatedAt: timestamp,
      });
      const record = ContextStoreRevisionRecordSchema.parse({
        schemaVersion: "pragma.context-store-revision-record/v1",
        storeId: id,
        revision: snapshot.revision,
        snapshotHash: snapshot.snapshotHash,
        parentRevision: current.contentRevision,
        author: "user",
        summary,
        createdAt: timestamp,
      });
      const pending = ContextStoreRevisionJournalSchema.parse({
        schemaVersion: "pragma.context-store-revision-journal/v1",
        storeId: id,
        previousFilesPath,
        stagedFilesPath,
        targetManifest,
        snapshot,
        record,
      });
      try {
        await writeJsonAtomic(join(storePath(id), "revision.json"), pending);
        await finalizeRevisionTransaction(id, pending);
        options.onPublished?.(id);
        return result;
      } catch (error) {
        if (!(await pathExists(join(storePath(id), "revision.json")))) {
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
        schemaVersion: "pragma.context-store/v4",
        contentRevision: 1,
        snapshotHash: hashSnapshotContent([], []),
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
    async get(storeId) {
      return await readStore(z.string().uuid().parse(storeId));
    },
    async withRevisionLock(storeId, operation) {
      return await withRevisionLock(storeId, operation);
    },
    async withDraftPublicationLock(storeId, operation) {
      return await withDraftPublicationLock(storeId, operation);
    },
    async exists(storeId) {
      try {
        await lstat(storePath(z.string().uuid().parse(storeId)));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
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
        const snapshot = await buildSnapshot(id, 1, join(temporaryPath, "files"), timestamp);
        const store = ContextStoreSchema.parse({
          schemaVersion: "pragma.context-store/v4",
          id,
          name: parsed.name,
          description: parsed.description,
          type: "file",
          status: "ready",
          source: { origin: parsed.mode === "blank" ? "created" : "copied" },
          contentRevision: 1,
          snapshotHash: snapshot.snapshotHash,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const record = ContextStoreRevisionRecordSchema.parse({
          schemaVersion: "pragma.context-store-revision-record/v1",
          storeId: id,
          revision: 1,
          snapshotHash: snapshot.snapshotHash,
          parentRevision: null,
          author: parsed.mode === "blank" ? "user" : "import",
          summary: parsed.mode === "blank" ? "Create knowledge base." : "Import knowledge base.",
          createdAt: timestamp,
        });
        await writeFile(join(temporaryPath, "store.json"), `${JSON.stringify(store, null, 2)}\n`, {
          mode: 0o600,
        });
        await writeJsonAtomic(
          join(temporaryPath, "revisions", "00000001", "snapshot.json"),
          await persistSnapshotManifest(id, snapshot),
        );
        await writeJsonAtomic(join(temporaryPath, "revisions", "00000001", "record.json"), record);
        await writeJsonAtomic(join(temporaryPath, SNAPSHOT_STORAGE_MARKER), {
          schemaVersion: "pragma.context-store-snapshot-storage/v2",
          storeId: id,
          migratedAt: timestamp,
        });
        await mkdir(options.storesPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
        options.onPublished?.(id);
        return store;
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    },
    async inspectImport(sourcePath) {
      return await inspectMarkdownSource(sourcePath);
    },
    async remove(storeId, expected): Promise<void> {
      const id = z.string().uuid().parse(storeId);
      const assertDeleteAllowed = async (): Promise<void> => {
        if (!(await pathExists(storePath(id)))) {
          throw new ContextStoreStoreError("store_not_found", `Knowledge base not found: ${id}`);
        }
        if (expected !== undefined) {
          const current = await readStore(id);
          if (
            current.contentRevision !== expected.revision ||
            current.snapshotHash !== expected.snapshotHash
          ) {
            throw new ContextStoreStoreError(
              "revision_conflict",
              "The knowledge base changed after its deletion was prepared.",
            );
          }
        }
        await deletionBindings(id);
        if (await options.isReferenced?.(id)) {
          throw new ContextStoreStoreError(
            "expert_referenced",
            "This knowledge base is mounted by one or more Experts. Remove it before deleting.",
          );
        }
        if (await options.hasUnmergedRevisionDrafts?.(id)) {
          throw new ContextStoreStoreError(
            "revision_drafts_present",
            "This knowledge base still has unmerged revision drafts. " +
              "Complete and merge them, or discard them before deleting.",
          );
        }
      };
      // Run the preflight under the Store lock, then release it before touching
      // Missions. Mission mutations acquire their owner lock before Store locks.
      await withRevisionLock(id, assertDeleteAllowed);
      try {
        await options.removeMissionMounts?.(id);
      } catch (error) {
        if (error instanceof ContextStoreStoreError) throw error;
        throw new ContextStoreStoreError(
          "mission_unmount_failed",
          "Mission references could not be fully cleared. The knowledge base was not deleted; refresh Missions and retry.",
        );
      }
      await withRevisionLock(
        id,
        async () =>
          await withDraftPublicationLock(id, async () => {
            await assertDeleteAllowed();
            if (await options.hasMissionReferences?.(id)) {
              throw new ContextStoreStoreError(
                "mission_referenced",
                "One or more Missions still reference this knowledge base. Refresh Missions and retry.",
              );
            }
            const { snapshot, refs } = await deletionBindings(id);
            if (snapshot !== undefined && refs.length > 0) {
              // Publish binding removal before deleting the authority. A crash leaves either
              // a valid unbound Store that can be retried, or an entirely removed Store.
              await options.project!.apply({
                baseRevision: snapshot.revision,
                upserts: [],
                removals: refs,
              });
            }
            if (options.trashItem !== undefined) await options.trashItem(storePath(id));
            else await rm(storePath(id), { recursive: true, force: true });
          }),
      );
      await options.onRemoved?.(id);
    },
    async listEntries(storeId) {
      await readStore(storeId);
      return (await collectManagedEntries(contentRoot(storeId))).filter(
        (entry) => !isGitMetadataPath(entry.id),
      );
    },
    async createFolder(storeId, id) {
      assertManagedEntryName(id, "directory");
      await mutateCurrentState(storeId, `Create folder ${id}.`, async (stagedRoot) => {
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
      return await mutateCurrentState(storeId, `Create ${id}.`, async (stagedRoot) => {
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
      assertVisibleKnowledgePath(id);
      return await mutateCurrentState(storeId, `Update ${id}.`, async (stagedRoot, currentRoot) => {
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
      assertVisibleKnowledgePath(id);
      assertVisibleKnowledgePath(nextId);
      const currentName = entryNameFromId(id, kind);
      const nextName = entryNameFromId(nextId, kind);
      if (currentName !== nextName) assertManagedEntryName(nextId, kind);
      await mutateCurrentState(storeId, `Rename ${id} to ${nextId}.`, async (stagedRoot) => {
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
      assertVisibleKnowledgePath(id);
      await mutateCurrentState(storeId, `Delete ${id}.`, async (stagedRoot) => {
        const target = await resolveEntryAtRoot(stagedRoot, id, kind, true);
        if (options.trashItem !== undefined) await options.trashItem(target);
        else await rm(target, { recursive: kind === "directory", force: false });
      });
    },
    async getContent(storeId: string, contentId: string): Promise<ContextStoreContent> {
      assertVisibleKnowledgePath(contentId);
      await readStore(storeId);
      const result = await fileStore(storeId).readContext({
        id: contentId,
        offset: CONTEXT_STORE_FILE_MAX_BYTES,
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
      const id = input.id === undefined ? randomUUID() : z.string().uuid().parse(input.id);
      return await withRevisionLock(id, async () => {
        const timestamp = new Date().toISOString();
        const files = ContextStoreSnapshotSchema.shape.files.parse(input.files);
        const directories = ContextStoreSnapshotSchema.shape.directories.parse(
          input.directories ?? [],
        );
        const targetPath = storePath(id);
        if (await pathExists(targetPath)) {
          throw new ContextStoreStoreError(
            "revision_conflict",
            "The reserved knowledge-base id is already occupied.",
          );
        }
        const temporaryPath = join(options.storesPath, `.${id}.${randomUUID()}.tmp`);
        const temporaryFiles = join(temporaryPath, "files");
        await mkdir(temporaryFiles, { recursive: true, mode: 0o700 });
        try {
          await materializeSnapshot(temporaryFiles, { directories, files });
          const snapshot = await buildSnapshot(id, 1, temporaryFiles, timestamp);
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
            schemaVersion: "pragma.context-store/v4",
            id,
            name: input.name,
            description: input.description,
            type: "file",
            status: "ready",
            source: { origin: "created" },
            contentRevision: 1,
            snapshotHash: snapshot.snapshotHash,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          const record = ContextStoreRevisionRecordSchema.parse({
            schemaVersion: "pragma.context-store-revision-record/v1",
            storeId: id,
            revision: 1,
            snapshotHash: snapshot.snapshotHash,
            parentRevision: null,
            author: input.author,
            ...(input.revisionJobId === undefined ? {} : { revisionJobId: input.revisionJobId }),
            summary: input.summary,
            createdAt: timestamp,
          });
          await writeJsonAtomic(join(temporaryPath, "store.json"), store);
          await writeJsonAtomic(
            join(temporaryPath, "revisions", "00000001", "snapshot.json"),
            await persistSnapshotManifest(id, snapshot),
          );
          await writeJsonAtomic(
            join(temporaryPath, "revisions", "00000001", "record.json"),
            record,
          );
          await writeJsonAtomic(join(temporaryPath, SNAPSHOT_STORAGE_MARKER), {
            schemaVersion: "pragma.context-store-snapshot-storage/v2",
            storeId: id,
            migratedAt: timestamp,
          });
          await mkdir(options.storesPath, { recursive: true, mode: 0o700 });
          await rename(temporaryPath, targetPath);
          options.onPublished?.(id);
          return store;
        } catch (error) {
          await rm(temporaryPath, { recursive: true, force: true });
          throw error;
        }
      });
    },
    async getSnapshot(storeId, revision) {
      const current = await readStore(storeId);
      const targetRevision = revision ?? current.contentRevision;
      try {
        const snapshot = await readSnapshot(storeId, targetRevision);
        const record = ContextStoreRevisionRecordSchema.parse(
          parseJson(
            await readFile(revisionRecordPath(storeId, targetRevision), "utf8"),
            `${storeId}/revisions/${targetRevision}/record.json`,
          ),
        );
        assertSnapshotInvariant(storeId, snapshot, {
          revision: targetRevision,
          ...(targetRevision === current.contentRevision
            ? { snapshotHash: current.snapshotHash }
            : {}),
        });
        if (
          record.storeId !== storeId ||
          record.revision !== targetRevision ||
          record.snapshotHash !== snapshot.snapshotHash ||
          (targetRevision === 1
            ? record.parentRevision !== null
            : record.parentRevision !== targetRevision - 1)
        ) {
          throw new ContextStoreStoreError(
            "config_invalid",
            `Knowledge base ${storeId} has an inconsistent revision ${targetRevision}.`,
          );
        }
        return snapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ContextStoreStoreError(
            "content_not_found",
            `Knowledge base revision ${targetRevision} does not exist.`,
          );
        }
        throw error;
      }
    },
    async applyChangeSet(input, author, revisionJobId) {
      const changeSet = ContextStoreChangeSetSchema.parse(input);
      if (changeSet.operation !== "revise") {
        throw new ContextStoreStoreError(
          "config_invalid",
          "Knowledge-base creation candidates must be published through createFromSnapshot.",
        );
      }
      return await withRevisionLock(changeSet.storeId, async () => {
        const current = await readStore(changeSet.storeId);
        if (
          current.contentRevision !== changeSet.baseRevision ||
          current.snapshotHash !== changeSet.baseSnapshotHash
        ) {
          throw new ContextStoreStoreError(
            "revision_conflict",
            "The knowledge base changed after this revision was prepared.",
          );
        }
        const base = await this.getSnapshot(changeSet.storeId, current.contentRevision);
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
        return await commitSnapshotRevision({
          current,
          directories: base.directories,
          files: [...files.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
          author,
          summary: changeSet.summary,
          revisionJobId,
        });
      });
    },
    async appendSnapshot(input, author) {
      const storeId = z.string().uuid().parse(input.storeId);
      const baseRevision = z.number().int().positive().parse(input.baseRevision);
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
      const summary = z.string().trim().min(1).max(2000).parse(input.summary);
      const name =
        input.name === undefined ? undefined : ContextStoreSchema.shape.name.parse(input.name);
      const description =
        input.description === undefined
          ? undefined
          : ContextStoreSchema.shape.description.parse(input.description);
      return await withRevisionLock(storeId, async () => {
        const current = await readStore(storeId);
        if (current.contentRevision !== baseRevision || current.snapshotHash !== baseSnapshotHash) {
          throw new ContextStoreStoreError(
            "revision_conflict",
            "The knowledge base changed after this revision was prepared.",
          );
        }
        if (current.snapshotHash === expectedSnapshotHash) {
          if (
            (name === undefined || current.name === name) &&
            (description === undefined || current.description === description)
          ) {
            return current;
          }
        }
        return await commitSnapshotRevision({
          current,
          directories,
          files,
          author,
          summary,
          expectedSnapshotHash,
          name,
          description,
        });
      });
    },
    async deleteRevisionRecord(storeId, revision, expectedSnapshotHash) {
      const canonicalStoreId = z.string().uuid().parse(storeId);
      const canonicalRevision = z.number().int().min(2).parse(revision);
      const canonicalSnapshotHash = z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(expectedSnapshotHash);
      await withRevisionLock(canonicalStoreId, async () => {
        const current = await readStore(canonicalStoreId);
        if (canonicalRevision > current.contentRevision) {
          throw new ContextStoreStoreError(
            "revision_conflict",
            "The knowledge base revision no longer exists.",
          );
        }
        const record = ContextStoreRevisionRecordSchema.parse(
          parseJson(
            await readFile(revisionRecordPath(canonicalStoreId, canonicalRevision), "utf8"),
            `${canonicalStoreId}/revisions/${canonicalRevision}/record.json`,
          ),
        );
        if (
          record.storeId !== canonicalStoreId ||
          record.revision !== canonicalRevision ||
          record.snapshotHash !== canonicalSnapshotHash
        ) {
          throw new ContextStoreStoreError(
            "revision_conflict",
            "The knowledge base revision changed. Refresh and try again.",
          );
        }
        if (record.author !== "user" || record.parentRevision === null) {
          throw new ContextStoreStoreError(
            "invalid_entry",
            "Only manually saved revision records can be deleted from the list.",
          );
        }
        const state = await readRevisionListState(canonicalStoreId);
        if (state.deletedRevisions.includes(canonicalRevision)) return;
        await writeJsonAtomic(revisionListStatePath(canonicalStoreId), {
          ...state,
          deletedRevisions: [...state.deletedRevisions, canonicalRevision].toSorted(
            (left, right) => left - right,
          ),
        });
      });
    },
    async history(storeId) {
      const current = await readStore(storeId);
      const listState = await readRevisionListState(storeId);
      if (listState.deletedRevisions.some((revision) => revision > current.contentRevision)) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${storeId} has invalid revision list state.`,
        );
      }
      const deletedRevisions = new Set(listState.deletedRevisions);
      const records: ContextStoreRevisionRecord[] = [];
      for (let revision = current.contentRevision; revision >= 1; revision -= 1) {
        try {
          const record = ContextStoreRevisionRecordSchema.parse(
            parseJson(
              await readFile(revisionRecordPath(storeId, revision), "utf8"),
              `${storeId}/revisions/${revision}/record.json`,
            ),
          );
          const snapshot = await readSnapshot(storeId, revision);
          assertSnapshotInvariant(storeId, snapshot, {
            revision,
            ...(revision === current.contentRevision ? { snapshotHash: current.snapshotHash } : {}),
          });
          if (
            record.storeId !== storeId ||
            record.revision !== revision ||
            record.snapshotHash !== snapshot.snapshotHash ||
            (revision === 1
              ? record.parentRevision !== null
              : record.parentRevision !== revision - 1)
          ) {
            throw new ContextStoreStoreError(
              "config_invalid",
              `Knowledge base ${storeId} has an inconsistent revision ${revision}.`,
            );
          }
          if (!deletedRevisions.has(revision)) records.push(record);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ContextStoreStoreError(
              "config_invalid",
              `Knowledge base ${storeId} is missing revision ${revision}.`,
            );
          }
          throw error;
        }
      }
      return records;
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
    resolve: reader.resolve,
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
  assertVisibleKnowledgePath(id);
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
function assertVisibleKnowledgePath(id: string): void {
  if (isGitMetadataPath(id)) {
    throw new ContextStoreStoreError(
      "invalid_entry",
      "Repository metadata is not a knowledge-base entry.",
    );
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
async function materializeSnapshot(
  root: string,
  snapshot: Pick<ContextStoreSnapshot, "directories" | "files">,
): Promise<void> {
  for (const directory of snapshot.directories.toSorted()) {
    await mkdir(resolve(root, ...directory.split("/")), { recursive: true, mode: 0o700 });
  }
  const adapter = new FileSystemContextStore({
    rootDir: root,
    maxContextBytes: CONTEXT_STORE_FILE_MAX_BYTES,
    allowGitMetadataPaths: true,
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
