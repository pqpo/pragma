import { z } from "zod";

const RuntimeEnvironmentCatalogEntryV1Schema = z.object({
  runtimeId: z.string().trim().min(1).max(200),
  latestRevision: z.number().int().positive(),
});

export const RuntimeEnvironmentCatalogV1Schema = z.object({
  schemaVersion: z.literal("pragma.runtime-environment-catalog/v1"),
  defaultRuntimeId: z.string().trim().min(1).max(200),
  entries: z.array(RuntimeEnvironmentCatalogEntryV1Schema),
});

export type RuntimeEnvironmentCatalogV1 = z.infer<typeof RuntimeEnvironmentCatalogV1Schema>;
