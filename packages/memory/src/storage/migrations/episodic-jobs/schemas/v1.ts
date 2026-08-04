import { z } from "zod";

export const EpisodicExtractionJobV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.memory-extraction-job/v1"),
    id: z.string().min(1),
    executionId: z.string().min(1),
    terminalMessageId: z.string().min(1),
    status: z.enum(["pending", "running", "needs_attention", "completed"]),
    attempts: z.number().int().nonnegative(),
    retryAt: z.string().datetime().optional(),
    leaseUntil: z.string().datetime().optional(),
    lastErrorCode: z.string().min(1).optional(),
    completion: z.enum(["retained", "rejected"]).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();
