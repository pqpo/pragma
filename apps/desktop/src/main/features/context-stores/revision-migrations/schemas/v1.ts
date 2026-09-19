import { z } from "zod";

export const ContextStoreRevisionRequestV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-request/v1"),
    storeId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(50_000),
    source: z.enum(["user", "memory-learning", "expert-reflection"]),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    provenance: z
      .object({
        executionId: z.string().min(1).max(200),
        invocationId: z.string().min(1).max(200),
        expertId: z.string().min(1).max(200),
        teamId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const LegacyChangeOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("upsert"),
    id: z.string(),
    previousContent: z.string().optional(),
    content: z.string(),
    metadata: z.any(),
  }),
  z.object({ operation: z.literal("rename"), id: z.string(), nextId: z.string() }),
  z.object({
    operation: z.literal("delete"),
    id: z.string(),
    previousContent: z.string().optional(),
  }),
]);

export const ContextStoreChangeSetV1Schema = z.object({
  schemaVersion: z.literal("pragma.context-store-change-set/v1"),
  storeId: z.string().uuid(),
  baseRevision: z.number().int().positive(),
  baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.string(),
  operations: z.array(LegacyChangeOperationSchema),
});

export const ContextStoreRevisionJobV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-job/v1"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    request: ContextStoreRevisionRequestV1Schema,
    state: z.enum([
      "pending",
      "running",
      "pending_review",
      "applying",
      "completed",
      "rejected",
      "needs_attention",
      "superseded",
    ]),
    changeSet: ContextStoreChangeSetV1Schema.optional(),
    supersededBy: z.string().uuid().optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ContextStoreRevisionJobV1 = z.infer<typeof ContextStoreRevisionJobV1Schema>;
