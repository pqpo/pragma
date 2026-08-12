import { MemorySubjectRefSchema } from "@pragma/shared";
import { z } from "zod";

export const SemanticExtractionJobV3Schema = z
  .object({
    schemaVersion: z.literal("pragma.memory-semantic-job/v3"),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    conversationRef: MemorySubjectRefSchema,
    sourceExecutionIds: z.array(z.string().min(1)).min(1).max(1_000),
    sourceUpdatedAt: z.string().datetime(),
    inputWatermark: z.string().min(1),
    executionId: z.string().min(1),
    terminalMessageId: z.string().min(1),
    status: z.enum([
      "waiting_idle",
      "pending",
      "running",
      "needs_attention",
      "completed",
      "expired",
    ]),
    attempts: z.number().int().nonnegative(),
    totalAttempts: z.number().int().nonnegative(),
    retryAt: z.string().datetime().optional(),
    eligibleAt: z.string().datetime().optional(),
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
