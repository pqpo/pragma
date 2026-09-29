import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  MemoryRetrievalSettingsSchema,
  UpdateMemoryRetrievalSettingsSchema,
  type MemoryRetrievalSettings,
  type UpdateMemoryRetrievalSettings,
} from "@pragma/shared";
export function createMemoryRetrievalSettingsStore(options: { pragmaHome: string }) {
  const path = new PragmaPaths(options).memoryRetrievalSettings();
  const get = async (): Promise<MemoryRetrievalSettings> => {
    try {
      return MemoryRetrievalSettingsSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { schemaVersion: "pragma.memory-retrieval/v1", revision: 0, enabled: false };
      throw new Error("embedding_settings_unavailable", { cause: error });
    }
  };
  return {
    get,
    async update(raw: UpdateMemoryRetrievalSettings) {
      const input = UpdateMemoryRetrievalSettingsSchema.parse(raw);
      return await withFileLock(`${path}.lock`, async () => {
        const current = await get();
        if (current.revision !== input.expectedRevision)
          throw new Error("embedding_settings_conflict");
        const { expectedRevision, ...value } = input;
        void expectedRevision;
        const next = MemoryRetrievalSettingsSchema.parse({
          ...value,
          schemaVersion: current.schemaVersion,
          revision: current.revision + 1,
        });
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const tmp = `${path}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
        await rename(tmp, path);
        return next;
      });
    },
  };
}
