import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";
import { ContextTriggerSchema } from "@pragma/shared";

import { withFileLock } from "@pragma/core";
import type {
  ExpertAgentContextItemListInput,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSeed,
  ExpertAgentContextResult,
  ExpertAgentContextStore,
  ExpertAgentStoredContextItem,
  ExpertAgentStoredContextItemDeleteInput,
  ExpertAgentStoredContextItemEditInput,
  ExpertAgentStoredContextItemEditResult,
  ExpertAgentStoredContextItemReadInput,
  ExpertAgentStoredContextItemReadResult,
  ExpertAgentStoredContextItemSearchInput,
  ExpertAgentStoredContextRegisterInput,
  ExpertAgentContextItemSummary,
} from "@pragma/core";
import { error, InMemoryContextStore } from "@pragma/core";

const ContextMetadataSchema = z.object({
  description: z.string().optional(),
  trigger: ContextTriggerSchema,
  trustLevel: z.enum(["system", "workspace", "user", "external"]).optional(),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  priority: z.enum(["critical", "high", "normal", "low"]),
});

const StoredContextSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  metadata: ContextMetadataSchema,
  revision: z.string().optional(),
  etag: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

const JsonContextPayloadSchema = z.object({
  schemaVersion: z.literal("pragma.context-json-store/v1"),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  items: z.array(StoredContextSchema),
});

type JsonContextPayload = z.infer<typeof JsonContextPayloadSchema>;

export interface JsonContextStoreOptions {
  readonly filePath: string;
  readonly maxContextBytes?: number | undefined;
}

export interface JsonContextStoreMetadata {
  readonly revision: number;
  readonly updatedAt: string;
  readonly itemCount: number;
}

export class JsonContextStore implements ExpertAgentContextStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly maxContextBytes: number | undefined;

  constructor(options: JsonContextStoreOptions) {
    this.filePath = options.filePath;
    this.lockPath = `${options.filePath}.lock`;
    this.maxContextBytes = options.maxContextBytes;
  }

  async inspect(): Promise<ExpertAgentContextResult<JsonContextStoreMetadata>> {
    try {
      const payload = await this.readPayload();
      return {
        ok: true,
        value: {
          revision: payload.revision,
          updatedAt: payload.updatedAt,
          itemCount: payload.items.length,
        },
      };
    } catch (caught) {
      return storeFailure("inspect", caught);
    }
  }

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    return await this.read("list", async (store) => await store.listContext(input));
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    return await this.read("read", async (store) => await store.readContext(input));
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    return await this.read("search", async (store) => await store.searchContext(input));
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    return await this.mutate("add", async (store) => await store.addContext(input));
  }

  async editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    return await this.mutate("edit", async (store) => await store.editContext(input));
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    return await this.mutate("delete", async (store) => await store.deleteContext(input));
  }

  private async read<T>(
    operation: string,
    action: (store: InMemoryContextStore) => Promise<ExpertAgentContextResult<T>>,
  ): Promise<ExpertAgentContextResult<T>> {
    try {
      return await action(this.toMemoryStore(await this.readPayload()));
    } catch (caught) {
      return storeFailure(operation, caught);
    }
  }

  private async mutate<T>(
    operation: string,
    action: (store: InMemoryContextStore) => Promise<ExpertAgentContextResult<T>>,
  ): Promise<ExpertAgentContextResult<T>> {
    try {
      return await withFileLock(this.lockPath, async () => {
        const payload = await this.readPayload();
        const store = this.toMemoryStore(payload);
        const result = await action(store);
        if (!result.ok) return result;
        await this.writePayload({
          schemaVersion: "pragma.context-json-store/v1",
          revision: payload.revision + 1,
          updatedAt: new Date().toISOString(),
          items: [...store.context.values()],
        });
        return result;
      });
    } catch (caught) {
      return storeFailure(operation, caught);
    }
  }

  private toMemoryStore(payload: JsonContextPayload): InMemoryContextStore {
    return new InMemoryContextStore({
      context: payload.items as readonly ExpertAgentContextItemSeed[],
      maxContextBytes: this.maxContextBytes,
    });
  }

  private async readPayload(): Promise<JsonContextPayload> {
    try {
      return JsonContextPayloadSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          schemaVersion: "pragma.context-json-store/v1",
          revision: 0,
          updatedAt: new Date(0).toISOString(),
          items: [],
        };
      }
      throw caught;
    }
  }

  private async writePayload(payload: JsonContextPayload): Promise<void> {
    const parsed = JsonContextPayloadSchema.parse(payload);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => undefined);
    } catch (caught) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw caught;
    }
  }
}

function storeFailure<T>(operation: string, caught: unknown): ExpertAgentContextResult<T> {
  return error("store_error", `JSON Context Store failed to ${operation}.`, {
    message: caught instanceof Error ? caught.message : String(caught),
  });
}
