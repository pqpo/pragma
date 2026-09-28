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
