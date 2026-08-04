import { z } from "zod";

export const SemanticExtractionJobV2Schema = z
  .object({
    schemaVersion: z.literal("pragma.memory-semantic-job/v2"),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    executionId: z.string().min(1),
    terminalMessageId: z.string().min(1),
    status: z.enum(["pending", "running", "needs_attention", "completed", "expired"]),
    attempts: z.number().int().nonnegative(),
    totalAttempts: z.number().int().nonnegative(),
    retryAt: z.string().datetime().optional(),
    leaseUntil: z.string().datetime().optional(),
    lastErrorCode: z.string().min(1).optional(),
    failureClass: z.enum(["configuration", "transient-exhausted"]).optional(),
    attentionSince: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    expiredAt: z.string().datetime().optional(),
    completion: z.enum(["retained", "rejected"]).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();
