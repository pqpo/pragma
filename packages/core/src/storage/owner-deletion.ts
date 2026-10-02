import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withFileLock } from "./file-lock.ts";
import type { PragmaPaths } from "./pragma-paths.ts";

const FenceSchema = z
  .object({
    schemaVersion: z.literal("pragma.owner-deletion/v1"),
    ownerId: z.string().min(1),
  })
  .strict();

/** Tiny immutable fence, checked inside synchronous Memory transactions too. */
export function isOwnerDeletionFenced(paths: PragmaPaths, ownerId: string): boolean {
  try {
    const fence = FenceSchema.parse(
      JSON.parse(readFileSync(paths.ownerDeletionMarker(ownerId), "utf8")),
    );
    if (fence.ownerId !== ownerId) throw new Error("Owner deletion fence owner mismatch.");
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

/** Caller holds the owner deletion barrier. Fences survive moving the owner. */
export async function fenceOwnerDeletion(
  paths: PragmaPaths,
  ids: readonly string[],
): Promise<void> {
  await Promise.all(
    [...new Set(ids)].map(async (ownerId) => {
      const path = paths.ownerDeletionMarker(ownerId);
      if (isOwnerDeletionFenced(paths, ownerId)) return;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify(
          FenceSchema.parse({
            schemaVersion: "pragma.owner-deletion/v1",
            ownerId,
          }),
        ),
        { mode: 0o600 },
      );
      await rename(temporary, path);
    }),
  );
}

/** Serialize a bounded storage commit with owner deletion; perform long work beforehand. */
export async function withOwnerDeletionAdmission<T>(
  paths: PragmaPaths,
  ids: readonly string[],
  action: () => Promise<T>,
): Promise<T | undefined> {
  const owners = [...new Set(ids)].toSorted();
  if (owners.some((id) => isOwnerDeletionFenced(paths, id))) return undefined;
  return await withFileLock(
    paths.executionDeletionBarrierLock(),
    async () => {
      const acquire = async (index: number): Promise<T | undefined> => {
        const id = owners[index];
        if (id === undefined) {
          if (owners.some((owner) => isOwnerDeletionFenced(paths, owner))) return undefined;
          return await action();
        }
        return await withFileLock(paths.executionLock(id), async () => await acquire(index + 1), {
          operation: "owner.deletion-admission",
        });
      };
      return await acquire(0);
    },
    { operation: "owner.deletion-admission-batch" },
  );
}
