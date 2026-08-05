import {
  EffectiveMemoryPolicySchema,
  MemoryAssetPolicyOverrideSchema,
  MemoryGlobalPolicySchema,
  MemoryModuleDiagnosticSchema,
  MemorySubjectRefSchema,
  MemoryRevisionBindingSchema,
  MemoryVisibilityPolicySchema,
  MemorySensitivitySchema,
  MemoryEvidenceEnvelopeSchema,
  SemanticFactSchema,
  KnowledgeCandidateSchema,
  KnowledgeContentSchema,
  KnowledgeSchema,
  KnowledgeSourceRevisionRefSchema,
  KnowledgeSourceSnapshotSchema,
} from "@pragma/shared";
import { z } from "zod";

export const DesktopMemoryPolicyTargetSchema = MemorySubjectRefSchema.refine(
  (target) =>
    target.type === "pragma.expert" ||
    target.type === "pragma.expert-team" ||
    target.type === "pragma.flow",
  "Memory policy target must be an Expert, ExpertTeam, or Flow.",
);

export const DesktopGlobalMemoryPolicySnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  effectiveFrom: z.string().datetime(),
  policy: MemoryGlobalPolicySchema,
});

export const DesktopAssetMemoryPolicySnapshotSchema = z.object({
  targetRef: DesktopMemoryPolicyTargetSchema,
  revision: z.number().int().nonnegative(),
  effectiveFrom: z.string().datetime(),
  policy: MemoryAssetPolicyOverrideSchema,
  effective: EffectiveMemoryPolicySchema,
});

export const UpdateDesktopGlobalMemoryPolicySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  policy: MemoryGlobalPolicySchema,
});

export const GetDesktopAssetMemoryPolicySchema = z.object({
  targetRef: DesktopMemoryPolicyTargetSchema,
});

export const UpdateDesktopAssetMemoryPolicySchema = z.object({
  targetRef: DesktopMemoryPolicyTargetSchema,
  expectedRevision: z.number().int().nonnegative(),
  policy: MemoryAssetPolicyOverrideSchema,
});

export const DesktopMemoryPlaneStatusSchema = z.object({
  state: z.enum(["running", "stopped", "degraded"]),
  feed: z.object({
    lastSequence: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    logicalBytes: z.number().int().nonnegative().default(0),
    fileBytes: z.number().int().nonnegative().default(0),
    receiptCount: z.number().int().nonnegative().default(0),
    oldestOccurredAt: z.string().datetime().optional(),
    safeThroughSequence: z.number().int().nonnegative().default(0),
    blockedBytes: z.number().int().nonnegative().default(0),
  }),
  delivery: z.object({
    pending: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
  }),
  lastError: z
    .object({
      code: z.string().min(1),
      occurredAt: z.iso.datetime(),
    })
    .optional(),
  modules: z.array(MemoryModuleDiagnosticSchema),
  storagePolicy: z
    .object({
      schemaVersion: z.literal("pragma.memory-storage-policy/v1"),
      canonicalFeedRetentionDays: z.literal(30),
      canonicalFeedTargetBytes: z.literal(512 * 1_024 * 1_024),
      evidenceMaxRecordsPerExecution: z.literal(2_000),
      evidenceMaxBytesPerExecution: z.literal(16 * 1_024 * 1_024),
      extractionPromptMaxBytes: z.literal(78_000),
      extractionIdleHours: z.literal(6),
      jobRecordRetentionDays: z.literal(30),
      failedPayloadRetentionDays: z.literal(30),
      deadLetterRetentionDays: z.literal(30),
      deadLetterMaxEntries: z.literal(10_000),
      deadLetterMaxBytes: z.literal(64 * 1_024 * 1_024),
    })
    .optional(),
  maintenance: z
    .object({
      lastRunAt: z.string().datetime().optional(),
      deletedEvents: z.number().int().nonnegative(),
      reclaimedBytes: z.number().int().nonnegative(),
      deletedDeadLetters: z.number().int().nonnegative(),
      deadLetterEntries: z.number().int().nonnegative(),
      deadLetterBytes: z.number().int().nonnegative(),
    })
    .default({
      deletedEvents: 0,
      reclaimedBytes: 0,
      deletedDeadLetters: 0,
      deadLetterEntries: 0,
      deadLetterBytes: 0,
    }),
});

export const DesktopMemoryExtractionTaskSchema = z.object({
  module: z.enum(["episodic", "semantic", "knowledge"]),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  lane: z.enum(["waiting", "attention", "running", "completed"]),
  title: z.string().trim().min(1).max(200).optional(),
  lastErrorCode: z.string().min(1).optional(),
  updatedAt: z.string().datetime(),
});

export const DesktopMemoryExtractionBoardSchema = z.object({
  tasks: z.array(DesktopMemoryExtractionTaskSchema),
  counts: z.object({
    waiting: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  }),
});

export const ManageDesktopMemoryExtractionTaskSchema = z
  .object({
    module: z.enum(["episodic", "semantic", "knowledge"]),
    action: z.enum(["expedite", "retry", "interrupt", "delete"]),
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const DesktopMemoryExtractorProfileSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-extractor-profile/v1"),
    revision: z.number().int().nonnegative(),
    mode: z.enum(["inherit-default", "pinned"]),
    runtimeId: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    thinkingLevel: z.string().min(1).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const UpdateDesktopMemoryExtractorProfileSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  profile: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("inherit-default") }).strict(),
    z
      .object({
        mode: z.literal("pinned"),
        runtimeId: z.string().trim().min(1),
        providerId: z.string().trim().min(1),
        modelId: z.string().trim().min(1),
        thinkingLevel: z.string().trim().min(1).optional(),
      })
      .strict(),
  ]),
});

export const DesktopMemoryExtractionSettingsSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-extraction-settings/v1"),
    revision: z.number().int().nonnegative(),
    allowToolAssisted: z
      .object({
        episodic: z.boolean(),
        semantic: z.boolean(),
      })
      .strict(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const UpdateDesktopMemoryExtractionSettingsSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    allowToolAssisted: DesktopMemoryExtractionSettingsSchema.shape.allowToolAssisted,
  })
  .strict();

export const ReviseDesktopSemanticFactSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
    patch: z
      .object({
        statement: z.string().trim().min(1).max(4_000).optional(),
        predicate: z
          .string()
          .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
          .max(200)
          .optional(),
        normalizedValue: z.string().trim().min(1).max(2_000).optional(),
        conflictMode: z.enum(["exclusive", "compatible"]).optional(),
        confidence: z.number().min(0).max(0.95).optional(),
        reviewAt: z.string().datetime().nullable().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      })
      .strict()
      .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
        message: "Semantic fact revision requires at least one change.",
      }),
  })
  .strict();

export const ReviewDesktopSemanticFactSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const DesktopSemanticFactSchema = SemanticFactSchema;

const DesktopMemoryCommonSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(["active", "invalidated"]),
  title: z.string().min(1),
  summary: z.string().min(1),
  rootRefs: z.array(MemorySubjectRefSchema),
  producerRefs: z.array(MemorySubjectRefSchema),
  evidenceRefs: z.array(z.string().min(1)),
  visibility: MemoryVisibilityPolicySchema,
  sensitivity: MemorySensitivitySchema,
  bindings: z.array(MemoryRevisionBindingSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const DesktopMemoryItemSchema = z.discriminatedUnion("module", [
  DesktopMemoryCommonSchema.extend({
    module: z.literal("episodic"),
    executionId: z.string().min(1),
    goal: z.string().min(1),
    outcome: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    valueScore: z.number().min(0).max(1),
    attempts: z.array(z.object({ description: z.string(), result: z.string().optional() })),
    failuresAndRecoveries: z.array(
      z.object({ failure: z.string(), recovery: z.string().optional() }),
    ),
  }).strict(),
  DesktopMemoryCommonSchema.extend({
    module: z.literal("semantic"),
    statement: z.string().min(1),
    subjectRefs: z.array(MemorySubjectRefSchema),
    predicate: z.string().min(1),
    normalizedValue: z.string().min(1),
    confidence: z.number().min(0).max(1),
    verifiedAt: z.string().datetime().optional(),
    reviewAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    conflictsWith: z.array(z.string().min(1)),
  }).strict(),
  z
    .object({
      module: z.literal("knowledge"),
      id: z.string().min(1),
      revision: z.number().int().positive(),
      status: z.enum(["active", "withdrawn"]),
      title: z.string().min(1),
      summary: z.string().min(1),
      rootRefs: z.array(MemorySubjectRefSchema),
      producerRefs: z.array(MemorySubjectRefSchema),
      evidenceRefs: z.array(z.string().min(1)).length(0),
      visibility: MemoryVisibilityPolicySchema,
      sensitivity: MemorySensitivitySchema,
      bindings: z.array(MemoryRevisionBindingSchema),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      guidance: z.array(z.string().min(1)),
      normalizedKey: z.string().min(1),
      sourceRefs: z.array(KnowledgeSourceRevisionRefSchema),
      origin: z.enum(["local", "bundle-import"]),
    })
    .strict(),
]);

export const DesktopMemoryItemListSchema = z.array(DesktopMemoryItemSchema);

export const ListDesktopMemoryItemsSchema = z
  .object({
    module: z.enum(["all", "episodic", "semantic", "knowledge"]).default("all"),
    status: z.enum(["active", "invalidated", "withdrawn", "all"]).default("active"),
    query: z.string().trim().max(2_000).default(""),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();

export const DesktopMemoryItemRefSchema = z
  .object({ module: z.enum(["episodic", "semantic", "knowledge"]), id: z.string().min(1) })
  .strict();

export const GetDesktopMemoryEvidenceSchema = z
  .object({
    module: z.enum(["episodic", "semantic"]),
    id: z.string().min(1),
    evidenceId: z.string().min(1),
  })
  .strict();

export const TightenDesktopMemoryAccessSchema = DesktopMemoryItemRefSchema.extend({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
  bindings: z.array(MemoryRevisionBindingSchema).min(1).max(100).optional(),
  visibility: MemoryVisibilityPolicySchema.optional(),
})
  .refine((value) => value.bindings !== undefined || value.visibility !== undefined, {
    message: "A binding or visibility change is required.",
  })
  .strict();

export const ReviewDesktopMemoryItemSchema = DesktopMemoryItemRefSchema.extend({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const DesktopMemoryEvidenceSchema = MemoryEvidenceEnvelopeSchema;

export const DesktopKnowledgeCandidateSchema = KnowledgeCandidateSchema;
export const DesktopKnowledgeCandidateListSchema = z.array(DesktopKnowledgeCandidateSchema);
export const ListDesktopKnowledgeCandidatesSchema = z
  .object({
    state: z
      .enum(["pending_review", "rejected", "published", "superseded", "all"])
      .default("pending_review"),
  })
  .strict();
export const UpdateDesktopKnowledgeCandidateSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    content: KnowledgeContentSchema,
  })
  .strict();
export const RejectDesktopKnowledgeCandidateSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const PublishDesktopKnowledgeCandidateSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
    bindings: z.array(MemoryRevisionBindingSchema).min(1).max(100),
    visibility: MemoryVisibilityPolicySchema,
    confirmPublic: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.visibility.mode !== "public" || input.confirmPublic, {
    path: ["confirmPublic"],
    message: "Public Knowledge publication requires explicit confirmation.",
  })
  .refine((input) => input.bindings.some((binding) => binding.recall === "allow"), {
    path: ["bindings"],
    message: "Knowledge publication requires at least one recall binding.",
  });
export const CreateDesktopKnowledgeSuccessorSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    content: KnowledgeContentSchema,
  })
  .strict();
export const DesktopKnowledgeSchema = KnowledgeSchema;
export const GetDesktopKnowledgeSourceSchema = z
  .object({ sourceRef: KnowledgeSourceRevisionRefSchema })
  .strict();
export const DesktopKnowledgeSourceSchema = KnowledgeSourceSnapshotSchema;

export const DesktopMissionMemoryActivitySchema = z.object({
  missionId: z.string().uuid(),
  executions: z.array(
    z.object({
      executionId: z.string().min(1),
      capture: z.object({ published: z.number(), skipped: z.number(), failed: z.number() }),
      recall: z.object({
        list: z.number(),
        search: z.number(),
        read: z.number(),
        denied: z.number(),
        failed: z.number(),
      }),
    }),
  ),
});

export const GetDesktopMissionMemoryActivitySchema = z.object({ missionId: z.string().uuid() });
