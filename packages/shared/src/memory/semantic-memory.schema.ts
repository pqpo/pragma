import { z } from "zod";

import {
  MemoryRevisionBindingSchema,
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryVisibilityPolicySchema,
} from "./memory-plane.schema.ts";

export const SEMANTIC_FACT_SCHEMA_VERSION = "pragma.memory-semantic/v1" as const;

export const SemanticFactRevisionRefSchema = z
  .object({
    factId: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

export const SemanticFactExtractorProvenanceSchema = z
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

export const SemanticFactSchema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_FACT_SCHEMA_VERSION),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    statement: z.string().trim().min(1).max(4_000),
    subjectRefs: z.array(MemorySubjectRefSchema).min(1).max(20),
    predicate: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
      .max(200),
    normalizedValue: z.string().trim().min(1).max(2_000),
    conflictMode: z.enum(["exclusive", "compatible"]),
    confidence: z.number().min(0).max(1),
    observedAt: z.string().datetime(),
    verifiedAt: z.string().datetime().optional(),
    reviewAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    evidenceRefs: z.array(z.string().min(1)).min(1).max(500),
    conflictsWith: z.array(z.string().min(1)).max(100),
    supersedes: z.array(SemanticFactRevisionRefSchema).max(100),
    status: z.enum(["active", "invalidated"]),
    invalidatedAt: z.string().datetime().optional(),
    visibility: MemoryVisibilityPolicySchema,
    sensitivity: MemorySensitivitySchema,
    bindings: z.array(MemoryRevisionBindingSchema).min(1).max(100),
    rootRefs: z.array(MemorySubjectRefSchema).min(1).max(20),
    producerRefs: z.array(MemorySubjectRefSchema).max(100),
    extractor: SemanticFactExtractorProvenanceSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((fact, context) => {
    if (fact.status === "invalidated" && fact.invalidatedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["invalidatedAt"],
        message: "Invalidated Semantic facts require invalidatedAt.",
      });
    }
    if (fact.status === "active" && fact.invalidatedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["invalidatedAt"],
        message: "Active Semantic facts cannot carry invalidatedAt.",
      });
    }
    for (const [field, value] of [
      ["reviewAt", fact.reviewAt],
      ["expiresAt", fact.expiresAt],
    ] as const) {
      if (value !== undefined && value <= fact.observedAt) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be later than observedAt.`,
        });
      }
    }
  });

export type SemanticFactRevisionRef = z.infer<typeof SemanticFactRevisionRefSchema>;
export type SemanticFactExtractorProvenance = z.infer<typeof SemanticFactExtractorProvenanceSchema>;
export type SemanticFact = z.infer<typeof SemanticFactSchema>;
