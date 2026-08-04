import {
  MemoryRevisionBindingSchema,
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryVisibilityPolicySchema,
} from "@pragma/shared";
import { z } from "zod";

const EvidenceRefsSchema = z.array(z.string().min(1)).min(1).max(100);
const ClaimSchema = z.object({
  text: z.string().min(1).max(4_000),
  evidenceRefs: EvidenceRefsSchema,
});

export const EpisodicMemoryRecordV2Schema = z.object({
  schemaVersion: z.literal("pragma.memory-episodic/v2"),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  executionId: z.string().min(1),
  terminalMessageId: z.string().min(1),
  rootRefs: z.array(MemorySubjectRefSchema).max(100),
  producerRefs: z.array(MemorySubjectRefSchema).max(100),
  language: z.string().min(2).max(32),
  goal: ClaimSchema,
  summary: ClaimSchema,
  attempts: z
    .array(
      z.object({
        description: z.string().min(1).max(2_000),
        result: z.string().min(1).max(2_000).optional(),
        evidenceRefs: EvidenceRefsSchema,
      }),
    )
    .max(50),
  failuresAndRecoveries: z
    .array(
      z.object({
        failure: z.string().min(1).max(2_000),
        recovery: z.string().min(1).max(2_000).optional(),
        evidenceRefs: EvidenceRefsSchema,
      }),
    )
    .max(50),
  outcome: z.object({
    status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    summary: z.string().min(1).max(4_000),
    evidenceRefs: EvidenceRefsSchema,
  }),
  artifactRefs: z.array(MemorySubjectRefSchema).max(100),
  evidenceRefs: z.array(z.string().min(1)).min(1).max(500),
  visibility: MemoryVisibilityPolicySchema,
  sensitivity: MemorySensitivitySchema,
  bindings: z.array(MemoryRevisionBindingSchema).min(1).max(100),
  valueScore: z.number().min(0).max(1),
  status: z.enum(["active", "invalidated"]),
  invalidatedAt: z.string().datetime().optional(),
  extractor: z.object({
    curatorRef: z.string().min(1),
    promptVersion: z.string().min(1),
    profileRevision: z.number().int().nonnegative(),
    runtimeId: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    responseModel: z.string().min(1).optional(),
    extractedAt: z.string().datetime(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
