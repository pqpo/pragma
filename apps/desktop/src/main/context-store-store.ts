import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  ContextNoteEntrySchema,
  ContextStoreSchema,
  CreateContextStoreSchema,
  type ContextNoteEntry,
  type ContextStore,
  type CreateContextStore,
} from "../shared/desktop-api.ts";

export interface ContextStoreStore {
  list(): Promise<ContextStore[]>;
  create(input: CreateContextStore): Promise<ContextStore>;
  addNoteEntry(storeId: string, entry: ContextNoteEntry): Promise<ContextStore>;
}

export class ContextStoreStoreError extends Error {
  constructor(
    readonly code: "config_invalid" | "store_not_found" | "entry_exists" | "invalid_store_type",
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

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export function createContextStoreStore(options: {
  readonly storesPath: string;
}): ContextStoreStore {
  const storePath = (id: string) => join(options.storesPath, id);
  const manifestPath = (id: string) => join(storePath(id), "store.json");
  const entriesPath = (id: string) => join(storePath(id), "entries");

  const readStore = async (id: string): Promise<ContextStore> => {
    try {
      const manifest = ContextStoreSchema.parse(
        parseJson(await readFile(manifestPath(id), "utf8"), `${id}/store.json`),
      );
      if (manifest.type === "file") return manifest;
      let entryFiles: string[] = [];
      try {
        entryFiles = (await readdir(entriesPath(id))).filter((name) => name.endsWith(".json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const entries = await Promise.all(
        entryFiles.map(async (name) =>
          ContextNoteEntrySchema.parse(
            parseJson(await readFile(join(entriesPath(id), name), "utf8"), `${id}/entries/${name}`),
          ),
        ),
      );
      return ContextStoreSchema.parse({ ...manifest, entries });
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
        if (store.type === "note") await mkdir(join(temporaryPath, "entries"), { mode: 0o700 });
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
      if (current.entries.some((candidate) => candidate.id === entry.id)) {
        throw new ContextStoreStoreError(
          "entry_exists",
          `Context entity ${entry.id} already exists.`,
        );
      }
      await mkdir(entriesPath(storeId), { recursive: true, mode: 0o700 });
      await writeJson(join(entriesPath(storeId), `${entry.id}.json`), entry);
      const updated = ContextStoreSchema.parse({
        ...current,
        entries: [...current.entries, entry],
        updatedAt: new Date().toISOString(),
      });
      await writeJson(manifestPath(storeId), { ...updated, entries: [] });
      return updated;
    },
  };
}
