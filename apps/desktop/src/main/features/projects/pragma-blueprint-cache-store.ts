import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PragmaBlueprintCacheStore } from "@pragma/interpreter";
import type { PragmaPaths } from "@pragma/core";

export function createDesktopPragmaBlueprintCacheStore(
  paths: PragmaPaths,
): PragmaBlueprintCacheStore {
  return {
    async read(key) {
      try {
        return await readFile(paths.compilerBlueprintCache(key));
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async write(key, value) {
      const target = paths.compilerBlueprintCache(key);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, value, { mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async remove(key) {
      await rm(paths.compilerBlueprintCache(key), { force: true });
    },
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
