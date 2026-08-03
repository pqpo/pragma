import {
  MemoryEvidenceEnvelopeSchema,
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryVisibilityPolicySchema,
} from "@pragma/shared";
import { z } from "zod";

export const EPISODIC_MEMORY_SCHEMA_VERSION = "pragma.memory-episodic/v1" as const;
export const EPISODIC_JOB_SCHEMA_VERSION = "pragma.memory-extraction-job/v1" as const;

const EvidenceRefsSchema = z.array(z.string().min(1)).min(1).max(100);

export const EpisodicClaimSchema = z.object({
  text: z.string().min(1).max(4_000),
  evidenceRefs: EvidenceRefsSchema,
});

export const EpisodicAttemptSchema = z.object({
  description: z.string().min(1).max(2_000),
  result: z.string().min(1).max(2_000).optional(),
  evidenceRefs: EvidenceRefsSchema,
});

export const EpisodicFailureRecoverySchema = z.object({
  failure: z.string().min(1).max(2_000),
  recovery: z.string().min(1).max(2_000).optional(),
  evidenceRefs: EvidenceRefsSchema,
});

export const EpisodicOutcomeSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
  summary: z.string().min(1).max(4_000),
  evidenceRefs: EvidenceRefsSchema,
});

export const EpisodicExtractorProvenanceSchema = z.object({
  curatorRef: z.string().min(1),
  promptVersion: z.string().min(1),
  profileRevision: z.number().int().nonnegative(),
  runtimeId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  responseModel: z.string().min(1).optional(),
  extractedAt: z.string().datetime(),
});

export const EpisodicMemoryRecordSchema = z.object({
  schemaVersion: z.literal(EPISODIC_MEMORY_SCHEMA_VERSION),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  executionId: z.string().min(1),
  terminalMessageId: z.string().min(1),
  rootRefs: z.array(MemorySubjectRefSchema).max(100),
  producerRefs: z.array(MemorySubjectRefSchema).max(100),
  language: z.string().min(2).max(32),
  goal: EpisodicClaimSchema,
  summary: EpisodicClaimSchema,
  attempts: z.array(EpisodicAttemptSchema).max(50),
  failuresAndRecoveries: z.array(EpisodicFailureRecoverySchema).max(50),
  outcome: EpisodicOutcomeSchema,
  artifactRefs: z.array(MemorySubjectRefSchema).max(100),
  evidenceRefs: z.array(z.string().min(1)).min(1).max(500),
  visibility: MemoryVisibilityPolicySchema,
  sensitivity: MemorySensitivitySchema,
  bindings: z.array(MemorySubjectRefSchema).max(100),
  valueScore: z.number().min(0).max(1),
  status: z.enum(["active", "invalidated"]),
  invalidatedAt: z.string().datetime().optional(),
  extractor: EpisodicExtractorProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const EpisodicExtractionInputSchema = z.object({
  schemaVersion: z.literal("pragma.memory-episodic-extraction-input/v1"),
  jobId: z.string().min(1),
  executionId: z.string().min(1),
  previousEpisode: EpisodicMemoryRecordSchema.optional(),
  evidence: z.array(MemoryEvidenceEnvelopeSchema).min(1).max(2_000),
});

const RetainedExtractionSchema = z.object({
  retain: z.literal(true),
  language: z.string().min(2).max(32),
  goal: EpisodicClaimSchema,
  summary: EpisodicClaimSchema,
  attempts: z.array(EpisodicAttemptSchema).max(50),
  failuresAndRecoveries: z.array(EpisodicFailureRecoverySchema).max(50),
  outcome: EpisodicOutcomeSchema,
  valueScore: z.number().min(0).max(1),
});

const RejectedExtractionSchema = z.object({
  retain: z.literal(false),
  reason: z.enum(["low-value", "insufficient-evidence", "sensitive"]),
});

export const EpisodicExtractionOutputSchema = z.discriminatedUnion("retain", [
  RetainedExtractionSchema,
  RejectedExtractionSchema,
]);

export const EpisodicExtractionJobSchema = z.object({
  schemaVersion: z.literal(EPISODIC_JOB_SCHEMA_VERSION),
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
});

export type EpisodicMemoryRecord = z.infer<typeof EpisodicMemoryRecordSchema>;
export type EpisodicExtractionInput = z.infer<typeof EpisodicExtractionInputSchema>;
export type EpisodicExtractionOutput = z.infer<typeof EpisodicExtractionOutputSchema>;
export type EpisodicExtractionJob = z.infer<typeof EpisodicExtractionJobSchema>;
export type EpisodicExtractorProvenance = z.infer<typeof EpisodicExtractorProvenanceSchema>;

export interface EpisodicMemoryExtractor {
  extract(input: EpisodicExtractionInput): Promise<{
    readonly output: EpisodicExtractionOutput;
    readonly provenance: EpisodicExtractorProvenance;
  }>;
}
