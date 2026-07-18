import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { StewardSessionStateSchema } from "./contracts.ts";
import type { StewardStateRepository } from "./ports.ts";

export function createFileStewardStateRepository(path: string): StewardStateRepository {
  return {
    async get() {
      try {
        return StewardSessionStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async put(state) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify(StewardSessionStateSchema.parse(state), null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      await rename(temporary, path);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}
