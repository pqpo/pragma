import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ContextStoreSchema,
  CreateContextStoreSchema,
  type ContextStore,
  type CreateContextStore,
} from "../shared/desktop-api.ts";
import { z } from "zod";

const ContextStoreCollectionSchema = z.object({
  schemaVersion: z.literal(1),
  stores: z.array(ContextStoreSchema),
});

export interface ContextStoreStore {
  list(): Promise<ContextStore[]>;
  create(input: CreateContextStore): Promise<ContextStore>;
}

export class ContextStoreStoreError extends Error {
  constructor(
    readonly code: "config_invalid",
    message: string,
  ) {
    super(message);
    this.name = "ContextStoreStoreError";
  }
}

export function createContextStoreStore(options: {
  readonly configPath: string;
}): ContextStoreStore {
  const readCollection = async (): Promise<z.infer<typeof ContextStoreCollectionSchema>> => {
    try {
      return ContextStoreCollectionSchema.parse(JSON.parse(await readFile(options.configPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, stores: [] };
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new ContextStoreStoreError(
          "config_invalid",
          "The context store configuration is invalid.",
        );
      }
      throw error;
    }
  };

  const writeCollection = async (
    collection: z.infer<typeof ContextStoreCollectionSchema>,
  ): Promise<void> => {
    await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${options.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(collection, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, options.configPath);
  };

  return {
    async list(): Promise<ContextStore[]> {
      const collection = await readCollection();
      return collection.stores.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async create(input: CreateContextStore): Promise<ContextStore> {
      const parsed = CreateContextStoreSchema.parse(input);
      const collection = await readCollection();
      const timestamp = new Date().toISOString();
      const store = ContextStoreSchema.parse({
        schemaVersion: "pragma.context-store/v1",
        id: randomUUID(),
        ...parsed,
        status: parsed.type === "file" ? "configured" : "ready",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeCollection({ schemaVersion: 1, stores: [store, ...collection.stores] });
      return store;
    },
  };
}
