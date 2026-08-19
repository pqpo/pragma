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

export const CanonicalEventSourceRefSchema = z.object({
  type: NamespacedNameSchema,
  id: z.string().min(1),
  ownerRef: z.object({ type: NamespacedNameSchema, id: z.string().min(1) }).optional(),
  cursor: z.string().min(1).optional(),
});

export const CanonicalEventEntityRefSchema = z.object({
  type: NamespacedNameSchema,
  id: z.string().min(1),
});

export const CanonicalEventRelatedRefSchema = z.object({
  relation: NamespacedNameSchema,
  ref: CanonicalEventEntityRefSchema,
});

export const CanonicalEventEnvelopeSchema = z.object({
  schemaVersion: z.literal("pragma.canonical-event/v1"),
  eventId: z.string().min(1),
  topic: NamespacedNameSchema,
  schemaRef: VersionedSchemaRefSchema,
  sourceRef: CanonicalEventSourceRefSchema,
  relatedRefs: z.array(CanonicalEventRelatedRefSchema).default([]),
  correlationId: z.string().min(1).optional(),
  causationId: z.string().min(1).optional(),
  occurredAt: z.string().datetime(),
  payload: z.unknown(),
});

export const CanonicalEventCursorSchema = z.object({
  sequence: z.number().int().nonnegative(),
});

export const MemorySubjectRefSchema = CanonicalEventEntityRefSchema;

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

export const MemoryPolicySwitchSchema = z.enum(["enabled", "disabled"]);
export const MemoryPolicyOverrideSwitchSchema = z.enum(["inherit", "enabled", "disabled"]);
export const MemoryLearningModeSchema = z.enum(["disabled", "local-candidates"]);
export const MemoryLearningOverrideSchema = z.enum(["inherit", "disabled", "local-candidates"]);

export const MemoryGlobalPolicyV1Schema = z.object({
  capture: MemoryPolicySwitchSchema,
  recall: MemoryPolicySwitchSchema,
  learning: MemoryLearningModeSchema,
});

export const MemoryGlobalPolicySchema = MemoryGlobalPolicyV1Schema.extend({
  enabled: MemoryPolicySwitchSchema,
});

export const MemoryAssetPolicyOverrideSchema = z.object({
  capture: MemoryPolicyOverrideSwitchSchema,
  recall: MemoryPolicyOverrideSwitchSchema,
  learning: MemoryLearningOverrideSchema,
});

export const MemoryPolicyRevisionV1Schema = z.discriminatedUnion("scope", [
  z.object({
    schemaVersion: z.literal("pragma.memory-policy/v1"),
    scope: z.literal("global"),
    revision: z.number().int().nonnegative(),
    effectiveFrom: z.string().datetime(),
    policy: MemoryGlobalPolicyV1Schema,
  }),
  z.object({
    schemaVersion: z.literal("pragma.memory-policy/v1"),
    scope: z.literal("asset"),
    targetRef: MemorySubjectRefSchema,
    revision: z.number().int().nonnegative(),
    effectiveFrom: z.string().datetime(),
    policy: MemoryAssetPolicyOverrideSchema,
  }),
]);

export const MemoryPolicyRevisionSchema = z.discriminatedUnion("scope", [
  z.object({
    schemaVersion: z.literal("pragma.memory-policy/v2"),
    scope: z.literal("global"),
    revision: z.number().int().nonnegative(),
    effectiveFrom: z.string().datetime(),
    policy: MemoryGlobalPolicySchema,
  }),
  z.object({
    schemaVersion: z.literal("pragma.memory-policy/v1"),
    scope: z.literal("asset"),
    targetRef: MemorySubjectRefSchema,
    revision: z.number().int().nonnegative(),
    effectiveFrom: z.string().datetime(),
    policy: MemoryAssetPolicyOverrideSchema,
  }),
]);

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

/**
 * Closed, model-safe projections of Runtime messages. These deliberately do not
 * carry reasoning, signatures, images, tool arguments, command output, or
 * provider diagnostics. Memory extractors must consume this projection instead
 * of the Runtime-native AgentMessage wire shape.
 */
export const MemorySafeExecutionMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    text: z.string().max(32_000),
  }),
  z.object({
    role: z.literal("assistant"),
    text: z.string().max(32_000),
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
  }),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    status: z.enum(["succeeded", "failed"]),
  }),
  z.object({
    role: z.literal("summary"),
    text: z.string().max(32_000),
    kind: z.enum(["branch", "compaction"]),
  }),
]);

export const MemorySafeExecutionMessagePayloadSchema = z.object({
  message: MemorySafeExecutionMessageSchema,
});

export const MemorySafeToolEventPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  phase: z.enum(["started", "completed", "failed"]),
});

export const MemorySafeTerminalPayloadSchema = z.object({
  outcome: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
});

export const MemoryFeedCursorSchema = CanonicalEventCursorSchema;

export const MemoryModuleDiagnosticSchema = z.object({
  moduleId: NamespacedNameSchema,
  moduleVersion: z.string().min(1),
  status: z.enum(["healthy", "degraded", "unavailable"]),
  cursor: MemoryFeedCursorSchema.optional(),
  lag: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  retried: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  lastErrorCode: z.string().min(1).optional(),
  work: z
    .object({
      records: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      needsAttention: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative().default(0),
      evidenceRecords: z.number().int().nonnegative().default(0),
      evidenceBytes: z.number().int().nonnegative().default(0),
      truncatedExecutions: z.number().int().nonnegative().default(0),
    })
    .optional(),
  updatedAt: z.string().datetime(),
});

export type CanonicalEventEnvelope = z.infer<typeof CanonicalEventEnvelopeSchema>;
export type CanonicalEventSourceRef = z.infer<typeof CanonicalEventSourceRefSchema>;
export type CanonicalEventEntityRef = z.infer<typeof CanonicalEventEntityRefSchema>;
export type CanonicalEventRelatedRef = z.infer<typeof CanonicalEventRelatedRefSchema>;
export type CanonicalEventCursor = z.infer<typeof CanonicalEventCursorSchema>;
export type MemorySubjectRef = z.infer<typeof MemorySubjectRefSchema>;
export type MemoryEvidenceSourceRef = z.infer<typeof MemoryEvidenceSourceRefSchema>;
export type MemoryVisibilityPolicy = z.infer<typeof MemoryVisibilityPolicySchema>;
export type MemorySensitivity = z.infer<typeof MemorySensitivitySchema>;
export type MemoryEvidenceBinding = z.infer<typeof MemoryEvidenceBindingSchema>;
export type MemoryEvidenceAttribution = z.infer<typeof MemoryEvidenceAttributionSchema>;
export type MemoryRevisionBinding = z.infer<typeof MemoryRevisionBindingSchema>;
export type MemoryEvidenceEnvelope = z.infer<typeof MemoryEvidenceEnvelopeSchema>;
export type MemorySafeExecutionMessage = z.infer<typeof MemorySafeExecutionMessageSchema>;
export type MemorySafeExecutionMessagePayload = z.infer<
  typeof MemorySafeExecutionMessagePayloadSchema
>;
export type MemorySafeToolEventPayload = z.infer<typeof MemorySafeToolEventPayloadSchema>;
export type MemorySafeTerminalPayload = z.infer<typeof MemorySafeTerminalPayloadSchema>;
export type MemoryPolicySwitch = z.infer<typeof MemoryPolicySwitchSchema>;
export type MemoryPolicyOverrideSwitch = z.infer<typeof MemoryPolicyOverrideSwitchSchema>;
export type MemoryLearningMode = z.infer<typeof MemoryLearningModeSchema>;
export type MemoryLearningOverride = z.infer<typeof MemoryLearningOverrideSchema>;
export type MemoryGlobalPolicyV1 = z.infer<typeof MemoryGlobalPolicyV1Schema>;
export type MemoryGlobalPolicy = z.infer<typeof MemoryGlobalPolicySchema>;
export type MemoryAssetPolicyOverride = z.infer<typeof MemoryAssetPolicyOverrideSchema>;
export type MemoryPolicyRevisionV1 = z.infer<typeof MemoryPolicyRevisionV1Schema>;
export type MemoryPolicyRevision = z.infer<typeof MemoryPolicyRevisionSchema>;
export type EffectiveMemoryPolicy = z.infer<typeof EffectiveMemoryPolicySchema>;
export type MemoryFeedCursor = z.infer<typeof MemoryFeedCursorSchema>;
export type MemoryModuleDiagnostic = z.infer<typeof MemoryModuleDiagnosticSchema>;
