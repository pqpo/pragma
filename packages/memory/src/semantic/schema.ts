import {
  MemoryEvidenceEnvelopeSchema,
  MemorySubjectRefSchema,
  SemanticFactExtractorProvenanceSchema,
  SemanticFactSchema,
} from "@pragma/shared";
import { z } from "zod";

export const SEMANTIC_JOB_SCHEMA_VERSION = "pragma.memory-semantic-job/v1" as const;
export const SEMANTIC_SUBJECT_CONTEXT_SCHEMA_VERSION =
  "pragma.memory-semantic-execution-subject-context/v1" as const;
export const SEMANTIC_GOVERNANCE_EVENT_SCHEMA_VERSION =
  "pragma.memory-semantic-governance-event/v1" as const;

export const SemanticFactCandidateSchema = z
  .object({
    statement: z.string().trim().min(1).max(4_000),
    subjectRefs: z.array(MemorySubjectRefSchema).min(1).max(20),
    predicate: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
      .max(200),
    normalizedValue: z.string().trim().min(1).max(2_000),
    conflictMode: z.enum(["exclusive", "compatible"]),
    confidence: z.number().min(0).max(0.95),
    evidenceRefs: z.array(z.string().min(1)).min(1).max(100),
    reviewAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const SemanticExtractionInputSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-semantic-extraction-input/v1"),
    jobId: z.string().min(1),
    executionId: z.string().min(1),
    allowedSubjectRefs: z.array(MemorySubjectRefSchema).min(1).max(200),
    evidence: z.array(MemoryEvidenceEnvelopeSchema).min(1).max(2_000),
  })
  .strict();

export const SemanticExtractionOutputSchema = z.discriminatedUnion("retain", [
  z
    .object({
      retain: z.literal(true),
      facts: z.array(SemanticFactCandidateSchema).min(1).max(50),
    })
    .strict(),
  z
    .object({
      retain: z.literal(false),
      reason: z.enum(["no-stable-fact", "insufficient-evidence", "sensitive"]),
    })
    .strict(),
]);

export const SemanticExtractionJobSchema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_JOB_SCHEMA_VERSION),
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

export const SemanticExecutionSubjectContextSchema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_SUBJECT_CONTEXT_SCHEMA_VERSION),
    executionId: z.string().min(1),
    subjectRefs: z.array(MemorySubjectRefSchema).min(1).max(20),
    registeredAt: z.string().datetime(),
  })
  .strict();

export const SemanticGovernanceEventSchema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_GOVERNANCE_EVENT_SCHEMA_VERSION),
    id: z.string().min(1),
    factId: z.string().min(1),
    previousRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    action: z.enum(["revise", "verify", "invalidate", "tighten-access"]),
    reason: z.string().trim().min(1).max(2_000),
    actorRef: MemorySubjectRefSchema,
    occurredAt: z.string().datetime(),
  })
  .strict();

export type SemanticFactCandidate = z.infer<typeof SemanticFactCandidateSchema>;
export type SemanticExtractionInput = z.infer<typeof SemanticExtractionInputSchema>;
export type SemanticExtractionOutput = z.infer<typeof SemanticExtractionOutputSchema>;
export type SemanticExtractionJob = z.infer<typeof SemanticExtractionJobSchema>;
export type SemanticExecutionSubjectContext = z.infer<typeof SemanticExecutionSubjectContextSchema>;
export type SemanticGovernanceEvent = z.infer<typeof SemanticGovernanceEventSchema>;

export interface SemanticMemoryExtractor {
  extract(input: SemanticExtractionInput): Promise<{
    readonly output: SemanticExtractionOutput;
    readonly provenance: z.infer<typeof SemanticFactExtractorProvenanceSchema>;
  }>;
}

export const SemanticFactRevisionSnapshotSchema = SemanticFactSchema;
export type SemanticFactRevisionSnapshot = z.infer<typeof SemanticFactRevisionSnapshotSchema>;
