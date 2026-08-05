import { z } from "zod";

import {
  MemoryRevisionBindingSchema,
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryVisibilityPolicySchema,
} from "./memory-plane.schema.ts";

export const KNOWLEDGE_CANDIDATE_SCHEMA_VERSION = "pragma.memory-knowledge-candidate/v1" as const;
export const KNOWLEDGE_SCHEMA_VERSION = "pragma.memory-knowledge/v1" as const;
export const KNOWLEDGE_JOB_SCHEMA_VERSION = "pragma.memory-knowledge-job/v1" as const;
export const KNOWLEDGE_EXTRACTION_INPUT_SCHEMA_VERSION =
  "pragma.memory-knowledge-extraction-input/v1" as const;
export const KNOWLEDGE_GOVERNANCE_EVENT_SCHEMA_VERSION =
  "pragma.memory-knowledge-governance-event/v1" as const;
export const KNOWLEDGE_SHARE_SCHEMA_VERSION = "pragma.memory-knowledge-share/v1" as const;

export const KnowledgeRevisionRefSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

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

export const KnowledgeCandidateSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_CANDIDATE_SCHEMA_VERSION),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    rootRef: MemorySubjectRefSchema,
    producerRefs: z.array(MemorySubjectRefSchema).max(100),
    content: KnowledgeContentSchema,
    sourceRefs: z.array(KnowledgeSourceRevisionRefSchema).min(1).max(100),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["pending_review", "rejected", "published", "superseded"]),
    proposedVisibility: MemoryVisibilityPolicySchema,
    proposedSensitivity: MemorySensitivitySchema,
    extractor: KnowledgeExtractorProvenanceSchema,
    rejectionReason: z.string().trim().min(1).max(2_000).optional(),
    publishedRef: KnowledgeRevisionRefSchema.optional(),
    successorOf: KnowledgeRevisionRefSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.state === "rejected" && candidate.rejectionReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "Rejected Knowledge candidates require a reason.",
      });
    }
    if (candidate.state === "published" && candidate.publishedRef === undefined) {
      context.addIssue({
        code: "custom",
        path: ["publishedRef"],
        message: "Published Knowledge candidates require a published reference.",
      });
    }
  });

export const KnowledgeOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("bundle-import"),
      sourceProjectFingerprint: z.string().min(1),
      sourceKnowledgeId: z.string().min(1),
      sourceRevision: z.number().int().positive(),
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
      importedAt: z.string().datetime(),
    })
    .strict(),
]);

export const KnowledgeSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    rootRef: MemorySubjectRefSchema,
    producerRefs: z.array(MemorySubjectRefSchema).max(100),
    content: KnowledgeContentSchema,
    sourceRefs: z.array(KnowledgeSourceRevisionRefSchema).max(100),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["active", "withdrawn"]),
    visibility: MemoryVisibilityPolicySchema,
    sensitivity: MemorySensitivitySchema,
    bindings: z.array(MemoryRevisionBindingSchema).min(1).max(100),
    origin: KnowledgeOriginSchema,
    extractor: KnowledgeExtractorProvenanceSchema.optional(),
    withdrawnAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((knowledge, context) => {
    if (knowledge.status === "withdrawn" && knowledge.withdrawnAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["withdrawnAt"],
        message: "Withdrawn Knowledge requires withdrawnAt.",
      });
    }
    if (knowledge.status === "active" && knowledge.withdrawnAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["withdrawnAt"],
        message: "Active Knowledge cannot carry withdrawnAt.",
      });
    }
  });

export const KnowledgeSourceSnapshotSchema = z
  .object({
    ref: KnowledgeSourceRevisionRefSchema,
    rootRef: MemorySubjectRefSchema,
    producerRefs: z.array(MemorySubjectRefSchema).max(100),
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
    status: z.enum(["pending", "running", "needs_attention", "completed"]),
    attempts: z.number().int().nonnegative(),
    retryAt: z.string().datetime().optional(),
    leaseUntil: z.string().datetime().optional(),
    lastErrorCode: z.string().min(1).optional(),
    failureClass: z.enum(["configuration", "transient-exhausted", "capacity"]).optional(),
    completion: z.enum(["retained", "rejected"]).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const KnowledgeGovernanceEventSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_GOVERNANCE_EVENT_SCHEMA_VERSION),
    id: z.string().min(1),
    knowledgeId: z.string().min(1),
    previousRevision: z.number().int().positive().optional(),
    revision: z.number().int().positive(),
    action: z.enum(["publish", "successor", "tighten-access", "withdraw", "bundle-import"]),
    reason: z.string().trim().min(1).max(2_000),
    actorRef: MemorySubjectRefSchema,
    occurredAt: z.string().datetime(),
  })
  .strict();

export const KnowledgeShareProvenanceSchema = z
  .object({
    sourceKind: z.enum(["episodic", "semantic", "imported"]),
    sourceId: z.string().min(1),
    sourceRevision: z.number().int().positive(),
    summary: z.string().trim().min(1).max(500),
  })
  .strict();

export const KnowledgeShareSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_SHARE_SCHEMA_VERSION),
    sourceProjectFingerprint: z.string().min(1),
    sourceRef: KnowledgeRevisionRefSchema,
    content: KnowledgeContentSchema,
    rootRef: MemorySubjectRefSchema,
    producerRefs: z.array(MemorySubjectRefSchema).max(100),
    visibility: MemoryVisibilityPolicySchema,
    sensitivity: MemorySensitivitySchema,
    bindings: z.array(MemoryRevisionBindingSchema).min(1).max(100),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    provenance: z.array(KnowledgeShareProvenanceSchema).max(100),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type KnowledgeRevisionRef = z.infer<typeof KnowledgeRevisionRefSchema>;
export type KnowledgeSourceRevisionRef = z.infer<typeof KnowledgeSourceRevisionRefSchema>;
export type KnowledgeContent = z.infer<typeof KnowledgeContentSchema>;
export type KnowledgeExtractorProvenance = z.infer<typeof KnowledgeExtractorProvenanceSchema>;
export type KnowledgeCandidate = z.infer<typeof KnowledgeCandidateSchema>;
export type KnowledgeOrigin = z.infer<typeof KnowledgeOriginSchema>;
export type Knowledge = z.infer<typeof KnowledgeSchema>;
export type KnowledgeSourceSnapshot = z.infer<typeof KnowledgeSourceSnapshotSchema>;
export type KnowledgeExtractionInput = z.infer<typeof KnowledgeExtractionInputSchema>;
export type KnowledgeExtractionCandidate = z.infer<typeof KnowledgeExtractionCandidateSchema>;
export type KnowledgeExtractionOutput = z.infer<typeof KnowledgeExtractionOutputSchema>;
export type KnowledgeExtractionJob = z.infer<typeof KnowledgeExtractionJobSchema>;
export type KnowledgeGovernanceEvent = z.infer<typeof KnowledgeGovernanceEventSchema>;
export type KnowledgeShareProvenance = z.infer<typeof KnowledgeShareProvenanceSchema>;
export type KnowledgeShare = z.infer<typeof KnowledgeShareSchema>;
