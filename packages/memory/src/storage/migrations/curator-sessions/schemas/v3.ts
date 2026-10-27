// Frozen from 24eb76daac417af5db5cf0ef724ccccdca5019ac.
// Includes frozen nested extraction protocols from the v3 writer.
// Keep historical validation independent of the current business aggregates.
import { z } from "zod";
import {
  MemoryEvidenceEnvelopeSchema,
  MemoryEvidenceOmissionStatsSchema,
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryRevisionBindingSchema,
  MemoryVisibilityPolicySchema,
} from "./evidence-v1.ts";
const EPISODIC_MEMORY_SCHEMA_VERSION = "pragma.memory-episodic/v3";
const SemanticFactExtractorProvenanceSchema = z
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

const EvidenceRefsSchema = z.array(z.string().min(1)).min(1).max(100);

const EpisodicClaimSchema = z.object({
  text: z.string().min(1).max(4_000),
  evidenceRefs: EvidenceRefsSchema,
});

const EpisodicAttemptSchema = z.object({
  description: z.string().min(1).max(2_000),
  result: z.string().min(1).max(2_000).optional(),
  evidenceRefs: EvidenceRefsSchema,
});

const EpisodicFailureRecoverySchema = z.object({
  failure: z.string().min(1).max(2_000),
  recovery: z.string().min(1).max(2_000).optional(),
  evidenceRefs: EvidenceRefsSchema,
});

const EpisodicOutcomeSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
  summary: z.string().min(1).max(4_000),
  evidenceRefs: EvidenceRefsSchema,
});

const EpisodicExtractorProvenanceSchema = z.object({
  curatorRef: z.string().min(1),
  promptVersion: z.string().min(1),
  profileRevision: z.number().int().nonnegative(),
  runtimeId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  responseModel: z.string().min(1).optional(),
  extractedAt: z.string().datetime(),
});

const EpisodicMemoryRecordSchema = z.object({
  schemaVersion: z.literal(EPISODIC_MEMORY_SCHEMA_VERSION),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  conversationRef: MemorySubjectRefSchema,
  sourceExecutionIds: z.array(z.string().min(1)).min(1).max(1_000),
  sourceUpdatedAt: z.string().datetime(),
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
  bindings: z.array(MemoryRevisionBindingSchema).min(1).max(100),
  valueScore: z.number().min(0).max(1),
  status: z.enum(["active", "invalidated"]),
  invalidatedAt: z.string().datetime().optional(),
  extractor: EpisodicExtractorProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const EpisodicExtractionInputSchema = z.object({
  schemaVersion: z.literal("pragma.memory-episodic-extraction-input/v2"),
  jobId: z.string().min(1),
  executionId: z.string().min(1),
  previousEpisode: EpisodicMemoryRecordSchema.optional(),
  evidence: z.array(MemoryEvidenceEnvelopeSchema).min(1).max(2_000),
  omittedEvidence: MemoryEvidenceOmissionStatsSchema,
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

const EpisodicExtractionOutputSchema = z.discriminatedUnion("retain", [
  RetainedExtractionSchema,
  RejectedExtractionSchema,
]);

const SemanticFactCandidateSchema = z
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
    replacementTarget: z
      .object({
        factId: z.string().min(1),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    reviewAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

const SemanticExtractionInputSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-semantic-extraction-input/v3"),
    jobId: z.string().min(1),
    executionId: z.string().min(1),
    allowedSubjectRefs: z.array(MemorySubjectRefSchema).min(1).max(200),
    currentFacts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            revision: z.number().int().positive(),
            statement: z.string().trim().min(1).max(4_000),
            subjectRefs: z.array(MemorySubjectRefSchema).min(1).max(20),
            predicate: z
              .string()
              .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
              .max(200),
            normalizedValue: z.string().trim().min(1).max(2_000),
            conflictMode: z.literal("exclusive"),
            observedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(100),
    evidence: z.array(MemoryEvidenceEnvelopeSchema).min(1).max(2_000),
    omittedEvidence: MemoryEvidenceOmissionStatsSchema,
  })
  .strict();

const SemanticExtractionOutputSchema = z.discriminatedUnion("retain", [
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

export const Fact = SemanticExtractionInputSchema.shape.currentFacts.element.extend({
  conflictMode: z.enum(["exclusive", "compatible"]),
});
export type ExtractionExistingFact = z.infer<typeof Fact>;
const Output = z.union([EpisodicExtractionOutputSchema, SemanticExtractionOutputSchema]);
const Provenance = SemanticFactExtractorProvenanceSchema;
const MemoryExtractionTypeSchema = z.enum(["episodic", "semantic"]);
const ConversationExtractionInputSchema = SemanticExtractionInputSchema.extend({
  schemaVersion: z.literal("pragma.memory-conversation-extraction-input/v1"),
  previousEpisode: EpisodicExtractionInputSchema.shape.previousEpisode,
  targets: z.array(MemoryExtractionTypeSchema).min(1).max(2),
  evidenceTypes: z.record(z.string(), z.array(MemoryExtractionTypeSchema).min(1)),
  jobs: z
    .object({
      episodic: z.object({ jobId: z.string(), watermark: z.string() }).strict().optional(),
      semantic: z.object({ jobId: z.string(), watermark: z.string() }).strict().optional(),
    })
    .strict(),
  omittedByType: z
    .object({
      episodic: EpisodicExtractionInputSchema.shape.omittedEvidence.optional(),
      semantic: SemanticExtractionInputSchema.shape.omittedEvidence.optional(),
    })
    .strict()
    .optional(),
})
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.targets).size !== input.targets.length)
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Requested memory types must be unique.",
      });
    for (const type of input.targets)
      if (input.jobs[type] === undefined)
        context.addIssue({
          code: "custom",
          path: ["jobs", type],
          message: "A requested type requires its original delivery identity.",
        });
    const ids = new Set(input.evidence.map((item) => item.messageId));
    for (const id of ids)
      if (input.evidenceTypes[id] === undefined)
        context.addIssue({
          code: "custom",
          path: ["evidenceTypes", id],
          message: "Evidence must declare its authorized memory types.",
        });
    for (const [id, types] of Object.entries(input.evidenceTypes))
      if (
        !ids.has(id) ||
        types.some((type) => !input.targets.includes(type)) ||
        new Set(types).size !== types.length
      )
        context.addIssue({
          code: "custom",
          path: ["evidenceTypes", id],
          message: "Evidence types must be unique requested types of an existing passage.",
        });
  });
const ConversationExtractionOutputSchema = z
  .object({
    episodic: EpisodicExtractionOutputSchema.optional(),
    semantic: SemanticExtractionOutputSchema.optional(),
  })
  .strict();
export const CuratorSessionV3Schema = z
  .object({
    schemaVersion: z.literal("pragma.memory-curator-session/v3"),
    toolContractVersion: z.union([z.literal(1), z.literal(2)]),
    key: z.string(),
    module: z.enum(["episodic", "semantic", "conversation"]),
    jobId: z.string(),
    watermark: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    input: z.union([
      EpisodicExtractionInputSchema,
      SemanticExtractionInputSchema,
      ConversationExtractionInputSchema,
    ]),
    facts: z.array(Fact).max(100),
    read: z.record(z.string(), z.array(z.tuple([z.number(), z.number()]))),
    calls: z.number().int().nonnegative(),
    deliveredTokens: z.number().int().nonnegative(),
    tokenLimit: z.number().int().positive(),
    candidates: z.record(z.string(), SemanticFactCandidateSchema),
    parts: z.record(z.string(), z.unknown()),
    provenance: Provenance.optional(),
    output: Output.optional(),
    results: ConversationExtractionOutputSchema,
    resultProvenance: z
      .object({ episodic: Provenance.optional(), semantic: Provenance.optional() })
      .strict(),
    missionId: z.string().min(1).optional(),
    continuations: z.number().int().min(0).max(3),
    admitted: z.boolean(),
    retryGeneration: z.number().int().nonnegative(),
    contextTypes: z.array(MemoryExtractionTypeSchema).min(1).max(2),
    restartPending: z.boolean(),
    pendingContinuation: z
      .object({
        requestId: z.string().min(1),
        previousExecutionId: z.string().min(1),
        retryAt: z.string().datetime(),
        prompt: z.string().min(1).max(8000),
      })
      .strict()
      .optional(),
    lastError: z.string().optional(),
  })
  .strict();
