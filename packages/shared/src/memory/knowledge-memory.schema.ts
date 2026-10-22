import { MEMORY_LEARNING_SOURCE_BODY_CHARACTERS } from "./learning-limits.ts";
import { z } from "zod";
import { MemoryExtractionFailureDiagnosticSchema } from "./extraction-failure.schema.ts";

import {
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryVisibilityPolicySchema,
} from "./memory-plane.schema.ts";

export const KNOWLEDGE_JOB_SCHEMA_VERSION = "pragma.memory-knowledge-job/v3" as const;
export const KnowledgeSourceRevisionRefSchema = z
  .object({
    kind: z.enum(["episodic", "semantic"]),
    id: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

export const KnowledgeSourceSnapshotSchema = z
  .object({
    ref: KnowledgeSourceRevisionRefSchema,
    rootRef: MemorySubjectRefSchema,
    producerRefs: z.array(MemorySubjectRefSchema).max(100),
    conversationRefs: z.array(MemorySubjectRefSchema).max(1000).optional(),
    outcome: z.enum(["succeeded", "failed", "cancelled", "interrupted"]).optional(),
    sourceExecutionIds: z.array(z.string().min(1)).max(1_000),
    title: z.string().trim().min(1).max(4_000),
    // Complete valid Episode projections: summary/outcome plus 50 attempts and recoveries.
    body: z.string().trim().min(1).max(MEMORY_LEARNING_SOURCE_BODY_CHARACTERS),
    observedAt: z.string().datetime(),
    verified: z.boolean(),
    valueScore: z.number().min(0).max(1).optional(),
    visibility: MemoryVisibilityPolicySchema,
    sensitivity: MemorySensitivitySchema,
  })
  .strict();

export const KnowledgeExtractionJobSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_JOB_SCHEMA_VERSION),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    rootRef: MemorySubjectRefSchema,
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    firstFactAt: z.string().datetime(),
    lastFactAt: z.string().datetime(),
    eligibleAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    status: z.enum(["pending", "running", "needs_attention", "completed"]),
    attempts: z.number().int().nonnegative(),
    retryAt: z.string().datetime().optional(),
    leaseUntil: z.string().datetime().optional(),
    lastErrorCode: z.string().min(1).optional(),
    lastErrorMessage: z.string().min(1).max(4_096).optional(),
    lastFailure: MemoryExtractionFailureDiagnosticSchema.optional(),
    failureClass: z.enum(["configuration", "transient-exhausted", "capacity"]).optional(),
    completion: z.enum(["retained", "rejected"]).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type KnowledgeSourceRevisionRef = z.infer<typeof KnowledgeSourceRevisionRefSchema>;
export type KnowledgeSourceSnapshot = z.infer<typeof KnowledgeSourceSnapshotSchema>;
export type KnowledgeExtractionJob = z.infer<typeof KnowledgeExtractionJobSchema>;
