import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import {
  access,
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

import { FileSystemContextStore, withFileLock, type ExpertAgentContextStore } from "@pragma/core";

import {
  ContextStoreContentMetadataSchema,
  ContextStoreSchema,
  CreateContextStoreSchema,
  type ContextStore,
  type ContextStoreContent,
  type ContextStoreContentMetadata,
  type ContextStoreEntry,
  type ContextStoreImportInspection,
  type CreateContextStore,
} from "../../../shared/contracts/index.ts";

const FILE_CONTENT_MAX_BYTES = 1_000_000;
const MIGRATION_READY_FILE = ".pragma-migration-ready.json";

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

const ContextStoreMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v1"),
  targetSchema: z.literal("pragma.context-store/v2"),
  sourcePath: z.string().min(1),
  temporaryFiles: z.string().min(1),
  targetManifest: ContextStoreSchema,
});

const ContextStoreMigrationReadySchema = z.object({
  schemaVersion: z.literal("pragma.context-store-migration-ready/v1"),
  storeId: z.string().uuid(),
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
  resolve(storeId: string): Promise<{
    readonly revision: string;
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

export function createContextStoreStore(options: {
  readonly storesPath: string;
  readonly isReferenced?: ((storeId: string) => Promise<boolean>) | undefined;
  readonly trashItem?: TrashItem | undefined;
}): ContextStoreStore {
  const storePath = (id: string) => join(options.storesPath, id);
  const manifestPath = (id: string) => join(storePath(id), "store.json");
  const contentRoot = (id: string) => join(storePath(id), "files");
  const fileStore = (id: string) =>
    new FileSystemContextStore({
      rootDir: contentRoot(id),
      maxContextBytes: FILE_CONTENT_MAX_BYTES,
    });

  const migrateFileStore = async (
    id: string,
    legacy: z.infer<typeof LegacyContextStoreV1Schema>,
  ): Promise<ContextStore> => {
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
      const current = ContextStoreSchema.safeParse(latestRaw);
      if (current.success) return current.data;

      const journal = join(storePath(id), "v1-to-v2.json");
      const migrated = () =>
        ContextStoreSchema.parse({
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

      const finalize = async (pending: ContextStoreMigrationJournal): Promise<ContextStore> => {
        await writeJsonAtomic(manifestPath(id), pending.targetManifest);
        await rm(join(contentRoot(id), MIGRATION_READY_FILE), { force: true });
        await rm(journal, { force: true });
        return pending.targetManifest;
      };
      const install = async (pending: ContextStoreMigrationJournal): Promise<ContextStore> => {
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

  const readStore = async (id: string): Promise<ContextStore> => {
    try {
      const raw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const current = ContextStoreSchema.safeParse(raw);
      if (current.success) return current.data;
      const legacy = LegacyContextStoreV1Schema.safeParse(raw);
      if (legacy.success) return await migrateFileStore(id, legacy.data);
      throw new ContextStoreStoreError(
        "config_invalid",
        `Context store ${id} uses an unsupported schema.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ContextStoreStoreError("store_not_found", "The knowledge base no longer exists.");
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

  const touchStore = async (id: string): Promise<void> => {
    const current = await readStore(id);
    await writeJsonAtomic(manifestPath(id), {
      ...current,
      updatedAt: new Date().toISOString(),
    });
  };

  const readLegacyCatalogEntry = async (id: string): Promise<ContextStore | undefined> => {
    try {
      const raw = parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`);
      const legacy = LegacyContextStoreV1Schema.safeParse(raw);
      if (!legacy.success || legacy.data.type === "note") return undefined;
      return ContextStoreSchema.parse({
        schemaVersion: "pragma.context-store/v2",
        id: legacy.data.id,
        name: legacy.data.name,
        description: legacy.data.description,
        type: "file",
        status: "needs_attention",
        source: { origin: "migrated" },
        createdAt: legacy.data.createdAt,
        updatedAt: legacy.data.updatedAt,
      });
    } catch {
      return undefined;
    }
  };

  const resolveEntry = async (
    storeId: string,
    id: string,
    kind: "file" | "directory",
    mustExist: boolean,
  ): Promise<string> => {
    await readStore(storeId);
    const normalized = normalizeEntryId(id, kind);
    const root = contentRoot(storeId);
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
      const store = ContextStoreSchema.parse({
        schemaVersion: "pragma.context-store/v2",
        id,
        name: parsed.name,
        description: parsed.description,
        type: "file",
        status: "ready",
        source: { origin: parsed.mode === "blank" ? "created" : "copied" },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const targetPath = storePath(id);
      const temporaryPath = join(options.storesPath, `.${id}.${randomUUID()}.tmp`);
      await mkdir(join(temporaryPath, "files"), { recursive: true, mode: 0o700 });
      try {
        if (parsed.mode === "import") {
          await copyMarkdownTree(parsed.sourcePath, join(temporaryPath, "files"));
        }
        await writeFile(join(temporaryPath, "store.json"), `${JSON.stringify(store, null, 2)}\n`, {
          mode: 0o600,
        });
        await mkdir(options.storesPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      return store;
    },

    async inspectImport(sourcePath) {
      return await inspectMarkdownSource(sourcePath);
    },

    async remove(storeId: string): Promise<void> {
      const raw = parseJson(await readFile(manifestPath(storeId), "utf8"), `${storeId}/store.json`);
      if (
        !ContextStoreSchema.safeParse(raw).success &&
        !LegacyContextStoreV1Schema.safeParse(raw).success
      ) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Knowledge base ${storeId} has invalid JSON data.`,
        );
      }
      if (await options.isReferenced?.(storeId)) {
        throw new ContextStoreStoreError(
          "store_referenced",
          "This knowledge base is mounted by one or more Experts. Remove it before deleting.",
        );
      }
      if (options.trashItem !== undefined) await options.trashItem(storePath(storeId));
      else await rm(storePath(storeId), { recursive: true, force: true });
    },

    async listEntries(storeId) {
      await readStore(storeId);
      return await collectManagedEntries(contentRoot(storeId));
    },

    async createFolder(storeId, id) {
      const target = await resolveEntry(storeId, id, "directory", false);
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
      assertInsideRoot(await realpath(contentRoot(storeId)), await realpath(target));
      await touchStore(storeId);
    },

    async createFile(storeId, id, content, metadata) {
      await resolveEntry(storeId, id, "file", false);
      const result = await fileStore(storeId).addContext({
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
      await touchStore(storeId);
      return toContent(result.value);
    },

    async updateFile(storeId, id, content, metadata, expectedRevision) {
      await resolveEntry(storeId, id, "file", true);
      const result = await fileStore(storeId).editContext({
        id,
        mode: "replace",
        content,
        metadata: toCoreMetadata(metadata),
        expectedRevision,
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
      await touchStore(storeId);
      return toContent(result.value);
    },

    async renameEntry(storeId, id, nextId, kind) {
      const source = await resolveEntry(storeId, id, kind, true);
      const target = await resolveEntry(storeId, nextId, kind, false);
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
      await touchStore(storeId);
    },

    async deleteEntry(storeId, id, kind) {
      const target = await resolveEntry(storeId, id, kind, true);
      if (options.trashItem !== undefined) await options.trashItem(target);
      else await rm(target, { recursive: kind === "directory", force: false });
      await touchStore(storeId);
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
          .update(JSON.stringify({ id: current.id, schemaVersion: current.schemaVersion }))
          .digest("hex"),
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
