// Frozen dependency snapshots shared by the actual v1/v2 Curator writers.
// Identical at de7aa331350e2439e5f5e23adfeef4559c33ecd1 and
// f509a8a4da91a00b6bbd1ca6d40362305c5ee929; never import live business schemas here.
import { z } from "zod";

const NamespacedNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/, "Expected a namespaced identifier.");

const VersionedSchemaRefSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\/v[1-9][0-9]*$/,
    "Expected a versioned schema reference.",
  );

export const MemorySubjectRefSchema = z.object({
  type: NamespacedNameSchema,
  id: z.string().min(1),
});

export const MemoryEvidenceSourceRefSchema = z.object({
  type: NamespacedNameSchema,
  id: z.string().min(1),
  canonicalEventId: z.string().min(1),
  cursor: z.string().min(1).optional(),
});

export const MemoryVisibilityPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("host-private") }),
  z.object({
    mode: z.literal("restricted"),
    principals: z.array(MemorySubjectRefSchema).min(1),
  }),
  z.object({ mode: z.literal("public") }),
]);

export const MemorySensitivitySchema = z.enum(["public", "internal", "confidential", "restricted"]);

export const MemoryEvidenceBindingSchema = z.object({
  consumerRef: MemorySubjectRefSchema,
  access: z.enum(["allow", "deny"]),
});

export const MemoryEvidenceAttributionSchema = z.object({
  rootRef: MemorySubjectRefSchema,
  producerRefs: z.array(MemorySubjectRefSchema).default([]),
});

export const MemoryRevisionBindingSchema = z.object({
  consumerRef: MemorySubjectRefSchema,
  recall: z.enum(["allow", "deny"]),
  export: z.enum(["allow", "deny"]),
  permissionRevision: z.number().int().positive(),
});

const MemoryLearningModeSchema = z.enum(["disabled", "local-candidates"]);

export const EffectiveMemoryPolicySchema = z.object({
  capture: z.boolean(),
  recall: z.boolean(),
  learning: MemoryLearningModeSchema,
  appliedRevisions: z.array(
    z.object({
      scope: z.enum(["global", "asset", "mission"]),
      targetRef: MemorySubjectRefSchema.optional(),
      revision: z.number().int().nonnegative(),
    }),
  ),
});

export const MemoryEvidenceEnvelopeSchema = z.object({
  schemaVersion: z.literal("pragma.memory-evidence/v1"),
  messageId: z.string().min(1),
  topic: NamespacedNameSchema,
  schemaRef: VersionedSchemaRefSchema,
  sourceRef: MemoryEvidenceSourceRefSchema,
  subjectRefs: z.array(MemorySubjectRefSchema).min(1),
  correlationId: z.string().min(1).optional(),
  conversationRef: MemorySubjectRefSchema.optional(),
  causationId: z.string().min(1).optional(),
  occurredAt: z.string().datetime(),
  visibility: MemoryVisibilityPolicySchema,
  sensitivity: MemorySensitivitySchema,
  bindings: z.array(MemoryEvidenceBindingSchema).default([]),
  attribution: MemoryEvidenceAttributionSchema.optional(),
  policySnapshot: EffectiveMemoryPolicySchema,
  payload: z.unknown(),
});

export const MemoryEvidenceOmissionStatsSchema = z.object({
  records: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  byTopic: z.record(z.string(), z.number().int().nonnegative()),
  firstOccurredAt: z.string().datetime().optional(),
  lastOccurredAt: z.string().datetime().optional(),
});
