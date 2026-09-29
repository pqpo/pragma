import { z } from "zod";
export const MemoryRetrievalSettingsSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-retrieval/v1"),
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    providerId: z.string().uuid().optional(),
    modelId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => !value.enabled || (value.providerId !== undefined && value.modelId !== undefined),
    "An embedding model is required.",
  );
export const UpdateMemoryRetrievalSettingsSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    providerId: z.string().uuid().optional(),
    modelId: z.string().min(1).optional(),
  })
  .strict();
export const MemoryRetrievalStatusSchema = z
  .object({
    settings: MemoryRetrievalSettingsSchema,
    state: z.enum(["disabled", "building", "ready", "degraded", "needs_attention"]),
    generation: z.string().optional(),
    activeGeneration: z.string().optional(),
    segments: z.number().int().nonnegative(),
    indexedMemories: z.number().int().nonnegative(),
    totalMemories: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errorCode: z.string().optional(),
  })
  .strict();
export type MemoryRetrievalSettings = z.infer<typeof MemoryRetrievalSettingsSchema>;
export type MemoryRetrievalStatus = z.infer<typeof MemoryRetrievalStatusSchema>;
export type UpdateMemoryRetrievalSettings = z.infer<typeof UpdateMemoryRetrievalSettingsSchema>;
