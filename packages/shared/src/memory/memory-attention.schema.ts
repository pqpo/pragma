import { z } from "zod";

export const MemoryAttentionStatusSchema = z
  .object({
    configured: z.boolean(),
    revision: z.number().int().nonnegative(),
    state: z.enum(["disabled", "ready", "degraded", "needs_attention"]),
    errorCode: z.string().optional(),
  })
  .strict();
export const UpdateMemoryAttentionSettingsSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    apiKey: z.string().trim().min(1).max(4_096).nullable(),
  })
  .strict();
export type MemoryAttentionStatus = z.infer<typeof MemoryAttentionStatusSchema>;
export type UpdateMemoryAttentionSettings = z.infer<typeof UpdateMemoryAttentionSettingsSchema>;

export const MemoryAttentionSelectionSchema = z
  .object({
    module: z.enum(["episodic", "semantic"]),
    memoryId: z.string(),
    revision: z.number().int().positive(),
    decisionMode: z.enum(["provider", "vector_unassessed"]),
    selectedPaths: z
      .array(
        z.object({
          fieldPath: z.string(),
          start: z.number(),
          end: z.number(),
          textHash: z.string(),
        }),
      )
      .max(12),
  })
  .strict();
export const MemoryAttentionContextSummarySchema = z
  .object({
    contextId: z.string(),
    version: z.number().int().nonnegative(),
    entries: z.array(MemoryAttentionSelectionSchema).max(8),
    errorCode: z.string().optional(),
  })
  .strict();
