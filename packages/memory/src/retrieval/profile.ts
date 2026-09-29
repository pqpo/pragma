import { z } from "zod";
export const EmbeddingProfileSchema = z
  .object({
    fingerprint: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    baseUrl: z.string().url(),
    maxInputTokens: z.number().int().positive(),
    maxBatchInputs: z.number().int().positive().max(2048),
    maxBatchTokens: z.number().int().positive(),
    projectionVersion: z.literal(1),
  })
  .strict();
export type EmbeddingProfile = z.infer<typeof EmbeddingProfileSchema>;
