import { z } from "zod";
import { MemoryExtractionFailureDiagnosticSchema } from "./extraction-failure.schema.ts";

import {
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryVisibilityPolicySchema,
} from "./memory-plane.schema.ts";

export const KNOWLEDGE_JOB_SCHEMA_VERSION = "pragma.memory-knowledge-job/v3" as const;
export const KNOWLEDGE_EXTRACTION_INPUT_SCHEMA_VERSION =
  "pragma.memory-knowledge-extraction-input/v2" as const;

export const KnowledgeSourceRevisionRefSchema = z
  .object({
    kind: z.enum(["episodic", "semantic"]),
    id: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

export const KnowledgeContentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(4_000),
    guidance: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
    normalizedKey: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .regex(/^[a-z0-9][a-z0-9._:/-]*$/),
  })
  .strict();

export const KnowledgeExtractorProvenanceSchema = z
  .object({
    curatorRef: z.string().min(1),
    promptVersion: z.string().min(1),
    profileRevision: z.number().int().nonnegative(),
    runtimeId: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    responseModel: z.string().min(1).optional(),
    extractedAt: z.string().datetime(),
  })
  .strict();

export const KnowledgeSourceSnapshotSchema = z
  .object({
    ref: KnowledgeSourceRevisionRefSchema,
    rootRef: MemorySubjectRefSchema,
    producerRefs: z.array(MemorySubjectRefSchema).max(100),
    sourceExecutionIds: z.array(z.string().min(1)).max(100),
    title: z.string().trim().min(1).max(500),
    body: z.string().trim().min(1).max(16_000),
    observedAt: z.string().datetime(),
    verified: z.boolean(),
    valueScore: z.number().min(0).max(1).optional(),
    visibility: MemoryVisibilityPolicySchema,
    sensitivity: MemorySensitivitySchema,
  })
  .strict();

export const KnowledgeExtractionInputSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_EXTRACTION_INPUT_SCHEMA_VERSION),
    jobId: z.string().min(1),
    rootRef: MemorySubjectRefSchema,
    sources: z.array(KnowledgeSourceSnapshotSchema).min(1).max(100),
  })
  .strict();

export const KnowledgeExtractionCandidateSchema = z
  .object({
    content: KnowledgeContentSchema,
    sourceRefs: z.array(KnowledgeSourceRevisionRefSchema).min(1).max(100),
  })
  .strict();

export const KnowledgeExtractionOutputSchema = z.discriminatedUnion("retain", [
  z
    .object({
      retain: z.literal(true),
      candidates: z.array(KnowledgeExtractionCandidateSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      retain: z.literal(false),
      reason: z.enum(["no-reusable-knowledge", "insufficient-sources", "sensitive"]),
    })
    .strict(),
]);

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
export type KnowledgeContent = z.infer<typeof KnowledgeContentSchema>;
export type KnowledgeExtractorProvenance = z.infer<typeof KnowledgeExtractorProvenanceSchema>;
export type KnowledgeSourceSnapshot = z.infer<typeof KnowledgeSourceSnapshotSchema>;
export type KnowledgeExtractionInput = z.infer<typeof KnowledgeExtractionInputSchema>;
export type KnowledgeExtractionCandidate = z.infer<typeof KnowledgeExtractionCandidateSchema>;
export type KnowledgeExtractionOutput = z.infer<typeof KnowledgeExtractionOutputSchema>;
export type KnowledgeExtractionJob = z.infer<typeof KnowledgeExtractionJobSchema>;
