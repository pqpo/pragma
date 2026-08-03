import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";
import { z } from "zod";

const DesktopMemorySubjectIdentitySchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-memory-subject-identity/v1"),
    localUserId: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();

export interface DesktopMemorySubjectIdentityStore {
  getLocalUserRef(): Promise<{ readonly type: "pragma.user"; readonly id: string }>;
}

export function createDesktopMemorySubjectIdentityStore(options: {
  readonly pragmaHome: string;
  readonly now?: (() => Date) | undefined;
}): DesktopMemorySubjectIdentityStore {
  const path = join(new PragmaPaths(options).memoryDataRoot(), "subject-identity.json");
  const now = options.now ?? (() => new Date());

  const read = async () => {
    try {
      return DesktopMemorySubjectIdentitySchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };

  return {
    async getLocalUserRef() {
      const existing = await read();
      if (existing !== undefined) return { type: "pragma.user", id: existing.localUserId };
      return await withFileLock(`${path}.lock`, async () => {
        const current = await read();
        if (current !== undefined) return { type: "pragma.user" as const, id: current.localUserId };
        const created = DesktopMemorySubjectIdentitySchema.parse({
          schemaVersion: "pragma.desktop-memory-subject-identity/v1",
          localUserId: randomUUID(),
          createdAt: now().toISOString(),
        });
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
        return { type: "pragma.user" as const, id: created.localUserId };
      });
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
