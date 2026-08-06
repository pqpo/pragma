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
} from "@pragma/shared";
import { z } from "zod";
import { ContextStoreIdSchema, ContextStoreSnapshotFileSchema } from "./context-stores.ts";

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
      schemaVersion: z.literal("pragma.memory-storage-policy/v2"),
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
      episodicMaxRecords: z.literal(10_000),
      semanticMaxRecords: z.literal(20_000),
      episodicMaxLogicalBytes: z.literal(512 * 1_024 * 1_024),
      semanticMaxLogicalBytes: z.literal(512 * 1_024 * 1_024),
      memoryMaxFullRevisions: z.literal(100),
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
  module: z.enum(["episodic", "semantic", "knowledge", "skill"]),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  lane: z.enum(["waiting", "attention", "running", "completed"]),
  title: z.string().trim().min(1).max(200).optional(),
  lastErrorCode: z.string().min(1).optional(),
  updatedAt: z.string().datetime(),
});

export const DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE = 10;

const DesktopMemoryExtractionPageCursorSchema = z
  .object({
    updatedAt: z.string().datetime(),
    tieBreaker: z.string().min(1),
  })
  .strict();

const DesktopMemoryExtractionPageRequestSchema = z
  .object({
    pageIndex: z.number().int().nonnegative(),
    cursor: DesktopMemoryExtractionPageCursorSchema.optional(),
  })
  .strict()
  .superRefine((page, context) => {
    if ((page.pageIndex === 0) !== (page.cursor === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Only the first extraction page may omit its cursor.",
      });
    }
  });

export const ListDesktopMemoryExtractionJobsSchema = z
  .object({
    pages: z
      .object({
        waiting: DesktopMemoryExtractionPageRequestSchema,
        attention: DesktopMemoryExtractionPageRequestSchema,
        running: DesktopMemoryExtractionPageRequestSchema,
        completed: DesktopMemoryExtractionPageRequestSchema,
      })
      .strict(),
  })
  .strict();

const DesktopMemoryExtractionLanePageSchema = z
  .object({
    tasks: z.array(DesktopMemoryExtractionTaskSchema).max(DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE),
    pageIndex: z.number().int().nonnegative(),
    pageCount: z.number().int().positive(),
    totalTasks: z.number().int().nonnegative(),
    nextCursor: DesktopMemoryExtractionPageCursorSchema.optional(),
  })
  .strict();

export const DesktopMemoryExtractionBoardSchema = z.object({
  lanes: z
    .object({
      waiting: DesktopMemoryExtractionLanePageSchema,
      attention: DesktopMemoryExtractionLanePageSchema,
      running: DesktopMemoryExtractionLanePageSchema,
      completed: DesktopMemoryExtractionLanePageSchema,
    })
    .strict(),
});

export const ManageDesktopMemoryExtractionTaskSchema = z
  .object({
    module: z.enum(["episodic", "semantic", "knowledge", "skill"]),
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

export const ProgressiveKnowledgeStoreFilesSchema = ContextStoreSnapshotFileSchema.array()
  .min(4)
  .max(1_000)
  .superRefine((files, context) => {
    const byId = new Map(files.map((file) => [file.id, file]));
    if (byId.size !== files.length) {
      context.addIssue({
        code: "custom",
        message: "Knowledge store file ids must be unique.",
      });
    }
    for (const [id, limit, trigger] of [
      ["guide.md", 2_048, "always_on"],
      ["overview.md", 3_072, "always_on"],
      ["index.md", 8_192, "model_decision"],
    ] as const) {
      const file = byId.get(id);
      if (file === undefined) {
        context.addIssue({ code: "custom", message: `${id} is required.` });
      } else {
        if (new TextEncoder().encode(file.content).byteLength > limit) {
          context.addIssue({ code: "custom", message: `${id} exceeds ${limit} bytes.` });
        }
        if (file.metadata.trigger !== trigger) {
          context.addIssue({ code: "custom", message: `${id} must use ${trigger}.` });
        }
      }
    }
    if (!files.some((file) => file.id.startsWith("items/"))) {
      context.addIssue({
        code: "custom",
        message: "At least one items/** document is required.",
      });
    }
    for (const file of files.filter((entry) => entry.id.startsWith("indexes/"))) {
      if (new TextEncoder().encode(file.content).byteLength > 8_192) {
        context.addIssue({
          code: "custom",
          message: `${file.id} exceeds 8192 bytes. Split large indexes into more shards.`,
        });
      }
    }
  });

export const MemoryKnowledgeInitializationCandidateSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-knowledge-initialization-candidate/v2"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    expertRef: z.string().regex(/^expert:[0-9a-hjkmnp-tv-z]{16}$/u),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    name: z.string().trim().min(1).max(50),
    description: z.string().trim().max(500),
    files: ProgressiveKnowledgeStoreFilesSchema,
    state: z.enum(["pending_review", "rejected", "created"]),
    storeId: ContextStoreIdSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.state === "created" && candidate.storeId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["storeId"],
        message: "Created candidates require a store id.",
      });
    }
  });

export const ListMemoryKnowledgeInitializationCandidatesSchema = z
  .object({
    state: z.enum(["all", "pending_review", "rejected", "created"]).default("pending_review"),
  })
  .strict();

export const MemoryKnowledgeInitializationCandidateRefSchema = z
  .object({ id: z.string().uuid(), expectedRevision: z.number().int().positive() })
  .strict();

export const UpdateMemoryKnowledgeInitializationCandidateSchema =
  MemoryKnowledgeInitializationCandidateRefSchema.extend({
    name: z.string().trim().min(1).max(50),
    description: z.string().trim().max(500),
    files: ContextStoreSnapshotFileSchema.array().min(4).max(1_000),
  }).strict();

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

const DesktopMemorySubjectNamesSchema = z
  .record(z.string().min(1), z.string().trim().min(1))
  .default({});

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
  subjectNames: DesktopMemorySubjectNamesSchema,
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
]);

export const DesktopMemoryItemListSchema = z.array(DesktopMemoryItemSchema);

export const ListDesktopMemoryItemsSchema = z
  .object({
    module: z.enum(["all", "episodic", "semantic"]).default("all"),
    status: z.enum(["active", "invalidated", "withdrawn", "all"]).default("active"),
    query: z.string().trim().max(2_000).default(""),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();

export const DesktopMemoryItemRefSchema = z
  .object({ module: z.enum(["episodic", "semantic"]), id: z.string().min(1) })
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
