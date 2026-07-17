import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  FileSystemContextStore,
  JsonContextStore,
  type ExpertAgentContextStore,
} from "@pragma/core";

import {
  ContextNoteEntrySchema,
  ContextStoreSchema,
  CreateContextStoreSchema,
  type ContextNoteEntry,
  type ContextStore,
  type ContextStoreContent,
  type ContextStoreContentSummary,
  type CreateContextStore,
} from "../shared/desktop-api.ts";

const CONTENT_PREVIEW_MAX_BYTES = 900_000;

export interface ContextStoreStore {
  list(): Promise<ContextStore[]>;
  create(input: CreateContextStore): Promise<ContextStore>;
  addNoteEntry(storeId: string, entry: ContextNoteEntry): Promise<ContextStore>;
  listContents(storeId: string): Promise<readonly ContextStoreContentSummary[]>;
  getContent(storeId: string, contentId: string): Promise<ContextStoreContent>;
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
      | "entry_exists"
      | "content_not_found"
      | "source_unavailable"
      | "invalid_store_type",
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
}): ContextStoreStore {
  const storePath = (id: string) => join(options.storesPath, id);
  const manifestPath = (id: string) => join(storePath(id), "store.json");
  const entriesPath = (id: string) => join(storePath(id), "entries");
  const contentsPath = (id: string) => join(storePath(id), "contexts.json");
  const noteStore = (id: string, path = contentsPath(id)) =>
    new JsonContextStore({ filePath: path, maxContextBytes: 100_000 });

  const migrateNoteStore = async (id: string): Promise<void> => {
    try {
      await readFile(contentsPath(id), "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let entryFiles: string[];
    try {
      entryFiles = (await readdir(entriesPath(id))).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const entries = await Promise.all(
      entryFiles.map(async (name) =>
        ContextNoteEntrySchema.parse(
          parseJson(await readFile(join(entriesPath(id), name), "utf8"), `${id}/entries/${name}`),
        ),
      ),
    );
    const temporaryPath = `${contentsPath(id)}.${randomUUID()}.migration`;
    const temporaryStore = noteStore(id, temporaryPath);
    try {
      if (entries.length === 0) {
        await writeFile(temporaryPath, `${JSON.stringify(emptyNotePayload(), null, 2)}\n`, {
          mode: 0o600,
        });
      }
      for (const entry of entries) {
        const result = await temporaryStore.addContext({
          id: entry.id,
          content: entry.content,
          metadata: {
            description: entry.description,
            trigger: entry.trigger,
            priority: "normal",
          },
        });
        if (!result.ok) throw new ContextStoreStoreError("config_invalid", result.error.message);
      }
      await rename(temporaryPath, contentsPath(id));
      await rm(entriesPath(id), { recursive: true, force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  };

  const readStore = async (id: string): Promise<ContextStore> => {
    try {
      const manifest = ContextStoreSchema.parse(
        parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`),
      );
      if (manifest.type === "file") return manifest;
      await migrateNoteStore(id);
      const store = noteStore(id);
      const listed = await store.listContext({});
      if (!listed.ok) throw new ContextStoreStoreError("config_invalid", listed.error.message);
      const entries = await Promise.all(
        listed.value.map(async (summary) => {
          const read = await store.readContext({ id: summary.id });
          if (!read.ok) throw new ContextStoreStoreError("config_invalid", read.error.message);
          return ContextNoteEntrySchema.parse({
            id: read.value.id,
            description: read.value.metadata.description ?? read.value.id,
            content: read.value.content,
            trigger: read.value.metadata.trigger,
          });
        }),
      );
      const metadata = await store.inspect();
      if (!metadata.ok) throw new ContextStoreStoreError("config_invalid", metadata.error.message);
      return ContextStoreSchema.parse({
        ...manifest,
        entries,
        updatedAt:
          metadata.value.updatedAt > manifest.updatedAt
            ? metadata.value.updatedAt
            : manifest.updatedAt,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ContextStoreStoreError("store_not_found", "The context store no longer exists.");
      }
      if (error instanceof ContextStoreStoreError) throw error;
      if (error instanceof z.ZodError) {
        throw new ContextStoreStoreError(
          "config_invalid",
          `Context store ${id} has invalid JSON data.`,
        );
      }
      throw error;
    }
  };

  return {
    async list(): Promise<ContextStore[]> {
      try {
        const directories = (await readdir(options.storesPath, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith("."),
        );
        const stores = await Promise.all(directories.map((entry) => readStore(entry.name)));
        return stores.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },

    async create(input: CreateContextStore): Promise<ContextStore> {
      const parsed = CreateContextStoreSchema.parse(input);
      const timestamp = new Date().toISOString();
      const store = ContextStoreSchema.parse({
        schemaVersion: "pragma.context-store/v1",
        id: randomUUID(),
        ...parsed,
        ...(parsed.type === "note" ? { entries: [] } : {}),
        status: parsed.type === "file" ? "configured" : "ready",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const targetPath = storePath(store.id);
      const temporaryPath = join(options.storesPath, `.${store.id}.${randomUUID()}.tmp`);
      await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
      try {
        await writeFile(join(temporaryPath, "store.json"), `${JSON.stringify(store, null, 2)}\n`, {
          mode: 0o600,
        });
        if (store.type === "note") {
          await writeFile(
            join(temporaryPath, "contexts.json"),
            `${JSON.stringify(emptyNotePayload(timestamp), null, 2)}\n`,
            { mode: 0o600 },
          );
        }
        await mkdir(options.storesPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      return store;
    },

    async addNoteEntry(storeId: string, input: ContextNoteEntry): Promise<ContextStore> {
      const entry = ContextNoteEntrySchema.parse(input);
      const current = await readStore(storeId);
      if (current.type !== "note") {
        throw new ContextStoreStoreError(
          "invalid_store_type",
          "Entities can only be added to a context note store.",
        );
      }
      const result = await noteStore(storeId).addContext({
        id: entry.id,
        content: entry.content,
        metadata: {
          description: entry.description,
          trigger: entry.trigger,
          priority: "normal",
        },
      });
      if (!result.ok) {
        throw new ContextStoreStoreError(
          result.error.code === "context_already_exists" ? "entry_exists" : "config_invalid",
          result.error.message,
        );
      }
      return await readStore(storeId);
    },

    async listContents(storeId: string): Promise<readonly ContextStoreContentSummary[]> {
      const current = await readStore(storeId);
      if (current.type === "note") {
        const result = await noteStore(storeId).listContext({});
        if (!result.ok)
          throw new ContextStoreStoreError("source_unavailable", result.error.message);
        return result.value.map((item) => ({
          id: item.id,
          metadata: item.metadata,
          ...(item.revision === undefined ? {} : { revision: item.revision }),
          ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes }),
        }));
      }

      const result = await new FileSystemContextStore({
        rootDir: current.source.path,
      }).listContext();
      if (!result.ok) {
        throw new ContextStoreStoreError("source_unavailable", result.error.message);
      }
      return result.value;
    },

    async getContent(storeId: string, contentId: string): Promise<ContextStoreContent> {
      const current = await readStore(storeId);
      if (current.type === "note") {
        const result = await noteStore(storeId).readContext({ id: contentId });
        if (!result.ok)
          throw new ContextStoreStoreError(
            result.error.code === "context_not_found" ? "content_not_found" : "source_unavailable",
            result.error.message,
          );
        return {
          id: result.value.id,
          content: result.value.content,
          metadata: result.value.metadata,
          ...(result.value.revision === undefined ? {} : { revision: result.value.revision }),
          ...(result.value.sizeBytes === undefined ? {} : { sizeBytes: result.value.sizeBytes }),
          truncated: result.value.contentRange.truncated,
        };
      }

      const result = await new FileSystemContextStore({ rootDir: current.source.path }).readContext(
        {
          id: contentId,
          offset: CONTENT_PREVIEW_MAX_BYTES,
        },
      );
      if (!result.ok) {
        throw new ContextStoreStoreError(
          result.error.code === "context_not_found" ? "content_not_found" : "source_unavailable",
          result.error.message,
        );
      }
      return {
        id: result.value.id,
        content: result.value.content,
        metadata: result.value.metadata,
        ...(result.value.revision === undefined ? {} : { revision: result.value.revision }),
        ...(result.value.sizeBytes === undefined ? {} : { sizeBytes: result.value.sizeBytes }),
        truncated: result.value.contentRange.truncated,
      };
    },

    async resolve(storeId) {
      const current = await readStore(storeId);
      return {
        revision: createHash("sha256")
          .update(
            JSON.stringify(
              current.type === "file"
                ? { id: current.id, type: current.type, source: current.source }
                : { id: current.id, type: current.type },
            ),
          )
          .digest("hex"),
        store:
          current.type === "file"
            ? new FileSystemContextStore({ rootDir: current.source.path })
            : noteStore(storeId),
      };
    },
  };
}

function emptyNotePayload(updatedAt = new Date().toISOString()) {
  return {
    schemaVersion: "pragma.context-json-store/v1" as const,
    revision: 0,
    updatedAt,
    items: [],
  };
}
