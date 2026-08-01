import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";
import { z } from "zod";

export const MemoryExtractorProfileSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-extractor-profile/v1"),
    revision: z.number().int().nonnegative(),
    mode: z.enum(["inherit-default", "pinned"]),
    runtimeId: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    thinkingLevel: z.string().min(1).optional(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((profile, context) => {
    const pinned = profile.mode === "pinned";
    for (const field of ["runtimeId", "providerId", "modelId"] as const) {
      if (pinned !== (profile[field] !== undefined)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: pinned
            ? `${field} is required for a pinned profile.`
            : `${field} is only valid for a pinned profile.`,
        });
      }
    }
  });

export type MemoryExtractorProfile = z.infer<typeof MemoryExtractorProfileSchema>;

export interface MemoryExtractorProfileStore {
  get(): Promise<MemoryExtractorProfile>;
  update(input: {
    readonly expectedRevision: number;
    readonly profile:
      | { readonly mode: "inherit-default" }
      | {
          readonly mode: "pinned";
          readonly runtimeId: string;
          readonly providerId: string;
          readonly modelId: string;
          readonly thinkingLevel?: string | undefined;
        };
  }): Promise<MemoryExtractorProfile>;
}

export function createFileMemoryExtractorProfileStore(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): MemoryExtractorProfileStore {
  const path = new PragmaPaths(options).memoryExtractorProfile();
  const now = options.now ?? (() => new Date());
  const initial = (): MemoryExtractorProfile =>
    MemoryExtractorProfileSchema.parse({
      schemaVersion: "pragma.memory-extractor-profile/v1",
      revision: 0,
      mode: "inherit-default",
      updatedAt: new Date(0).toISOString(),
    });
  const read = async (): Promise<MemoryExtractorProfile> => {
    try {
      return MemoryExtractorProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isNotFound(error)) return initial();
      throw error;
    }
  };
  return {
    get: read,
    async update(input) {
      return await withFileLock(`${path}.lock`, async () => {
        const current = await read();
        if (current.revision !== input.expectedRevision) {
          const error = new Error("memory_extractor_profile_revision_conflict");
          Object.assign(error, { expected: input.expectedRevision, actual: current.revision });
          throw error;
        }
        const next = MemoryExtractorProfileSchema.parse({
          schemaVersion: "pragma.memory-extractor-profile/v1",
          revision: current.revision + 1,
          ...input.profile,
          updatedAt: now().toISOString(),
        });
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
        return next;
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
