import {
  ContextTriggerSchema,
  SkillPackageFileSchema,
  SkillSourceRevisionRefSchema,
  pragmaKnowledgeBaseEntryNameIssue,
} from "@pragma/shared";
import { z } from "zod";

export const BuiltInAgentModelConfigSchema = z.object({
  runtimeId: z.string().trim().min(1).max(200),
  providerId: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(200),
  thinkingLevel: z.string().trim().min(1).max(100).optional(),
});

const RevisionProfileShape = {
  revision: z.number().int().nonnegative(),
  mode: z.enum(["inherit-default", "pinned"]),
  model: BuiltInAgentModelConfigSchema.optional(),
  updatedAt: z.string().datetime(),
};

function validateProfile(
  profile: { readonly mode: "inherit-default" | "pinned"; readonly model?: unknown },
  context: z.RefinementCtx,
): void {
  if ((profile.mode === "pinned") !== (profile.model !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["model"],
      message: "Pinned profiles require a model and inherited profiles cannot pin one.",
    });
  }
}

export const UpdateBuiltInAgentProfileSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    mode: z.enum(["inherit-default", "pinned"]),
    model: BuiltInAgentModelConfigSchema.optional(),
  })
  .strict()
  .superRefine(validateProfile);

export const ContextStoreRevisionProfileSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-profile/v1"),
    ...RevisionProfileShape,
  })
  .strict()
  .superRefine(validateProfile);

export const UpdateContextStoreRevisionProfileSchema = UpdateBuiltInAgentProfileSchema;

export const ContextStoreRevisionRequestSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-request/v1"),
    storeId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(50_000),
    source: z.enum(["user", "memory-learning"]),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.source === "memory-learning" && request.sourceDigest === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "Memory learning revisions require a source digest.",
      });
    }
    if (request.source === "user" && request.sourceDigest !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "User revision requests cannot attach a Memory source digest.",
      });
    }
  });

export const ContextStoreContentMetadataSchema = z.object({
  description: z.string().max(2_000).optional(),
  trigger: ContextTriggerSchema,
  trustLevel: z.enum(["system", "workspace", "user", "external"]).optional(),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  priority: z.enum(["critical", "high", "normal", "low"]),
});

function isSafeRelativeEntryId(value: string, kind: "file" | "directory"): boolean {
  const portable = value.replaceAll("\\", "/");
  const normalized = portable.replace(/\/+$/gu, "");
  return (
    normalized.length > 0 &&
    !portable.startsWith("/") &&
    !/^[a-z]:/iu.test(portable) &&
    !normalized
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..") &&
    (kind === "directory" || normalized.toLowerCase().endsWith(".md"))
  );
}

const StoredDirectoryPathSchema = z
  .string()
  .min(1)
  .refine((value) => isSafeRelativeEntryId(value, "directory"), {
    message: "Directory path must stay inside the knowledge base.",
  });

const StoredMarkdownPathSchema = z
  .string()
  .min(1)
  .refine((value) => isSafeRelativeEntryId(value, "file"), {
    message: "File path must be a relative Markdown path inside the knowledge base.",
  });

const ManagedMarkdownPathSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => {
    const filename = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
    return (
      isSafeRelativeEntryId(value, "file") &&
      pragmaKnowledgeBaseEntryNameIssue(filename.replace(/\.md$/iu, "")) === undefined
    );
  }, "The file name is not portable or exceeds 100 characters.");

export const ContextStoreRevisionSnapshotSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-snapshot/v1"),
    storeId: z.string().uuid(),
    revision: z.number().int().positive(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.string().datetime(),
    directories: z.array(StoredDirectoryPathSchema).default([]),
    files: z.array(
      z.object({
        id: StoredMarkdownPathSchema,
        content: z.string().max(1_000_000),
        metadata: ContextStoreContentMetadataSchema,
      }),
    ),
  })
  .superRefine((snapshot, context) => {
    const fileIds = new Set<string>();
    for (const [index, file] of snapshot.files.entries()) {
      if (fileIds.has(file.id)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "id"],
          message: `Duplicate snapshot file id: ${file.id}`,
        });
      }
      fileIds.add(file.id);
    }
    const directoryIds = new Set<string>();
    for (const [index, id] of snapshot.directories.entries()) {
      if (directoryIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["directories", index],
          message: `Duplicate snapshot directory id: ${id}`,
        });
      }
      directoryIds.add(id);
    }
  });

export const ProgressiveKnowledgeStoreFilesSchema = ContextStoreRevisionSnapshotSchema.shape.files
  .min(4)
  .max(1_000)
  .superRefine((files, context) => {
    const byId = new Map(files.map((file) => [file.id, file]));
    if (byId.size !== files.length) {
      context.addIssue({ code: "custom", message: "Knowledge store file ids must be unique." });
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
      context.addIssue({ code: "custom", message: "At least one items/** document is required." });
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

export const ContextStoreChangeOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("upsert"),
    id: ManagedMarkdownPathSchema,
    previousContent: z.string().max(1_000_000).optional(),
    content: z.string().max(1_000_000),
    metadata: ContextStoreContentMetadataSchema,
  }),
  z.object({
    operation: z.literal("rename"),
    id: StoredMarkdownPathSchema,
    nextId: ManagedMarkdownPathSchema,
  }),
  z.object({
    operation: z.literal("delete"),
    id: StoredMarkdownPathSchema,
    previousContent: z.string().max(1_000_000).optional(),
  }),
]);

export const ContextStoreChangeSetSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-change-set/v1"),
  storeId: z.string().uuid(),
  baseRevision: z.number().int().positive(),
  baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.string().trim().min(1).max(2_000),
  operations: z.array(ContextStoreChangeOperationSchema).min(1).max(1_000),
});

export const ContextStoreRevisionJobStateSchema = z.enum([
  "pending",
  "running",
  "pending_review",
  "applying",
  "completed",
  "rejected",
  "needs_attention",
  "superseded",
]);

export const ContextStoreRevisionJobSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-job/v1"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    request: ContextStoreRevisionRequestSchema,
    state: ContextStoreRevisionJobStateSchema,
    changeSet: ContextStoreChangeSetSchema.optional(),
    supersededBy: z.string().uuid().optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const ListContextStoreRevisionJobsSchema = z
  .object({
    storeId: z.string().uuid().optional(),
    state: ContextStoreRevisionJobStateSchema.optional(),
  })
  .strict();

export const ContextStoreRevisionJobRefSchema = z
  .object({ jobId: z.string().uuid(), expectedRevision: z.number().int().positive() })
  .strict();

export const SkillReplayCaseSchema = z
  .object({
    objective: z.string().min(1).max(4_000),
    requiredBehaviors: z.array(z.string().min(1).max(2_000)).min(1).max(20),
    forbiddenBehaviors: z.array(z.string().min(1).max(2_000)).max(20),
  })
  .strict();

export const SkillEvaluationSnapshotSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-evaluation-snapshot/v1"),
    subjectHash: z.string().regex(/^[a-f0-9]{64}$/u),
    passed: z.boolean(),
    staticChecksPassed: z.boolean(),
    scriptTestsPassed: z.boolean(),
    profileRevision: z.number().int().nonnegative(),
    runtimeId: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: z.enum(["source-replay", "boundary"]),
            passed: z.boolean(),
            assertions: z.array(
              z
                .object({
                  dimension: z.enum([
                    "applicability",
                    "correctness",
                    "completeness",
                    "recovery",
                    "safety",
                  ]),
                  passed: z.boolean(),
                  message: z.string().min(1).max(2_000),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(4)
      .max(20),
    evaluatedAt: z.string().datetime(),
  })
  .strict();

export const SkillEvaluationProfileSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-evaluation-profile/v1"),
    ...RevisionProfileShape,
  })
  .strict()
  .superRefine(validateProfile);

export const UpdateSkillEvaluationProfileSchema = UpdateBuiltInAgentProfileSchema;

export const SkillFileChangeOperationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("upsert"),
      path: SkillPackageFileSchema.shape.path,
      content: SkillPackageFileSchema.shape.content,
      previousContent: z.string().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("rename"),
      path: SkillPackageFileSchema.shape.path,
      nextPath: SkillPackageFileSchema.shape.path,
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      path: SkillPackageFileSchema.shape.path,
      previousContent: z.string().optional(),
    })
    .strict(),
]);

export const SkillRevisionChangeSetSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-change-set/v1"),
    capabilityId: z.string().uuid(),
    baseRevision: z.number().int().positive(),
    baseContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(2_000),
    operations: z.array(SkillFileChangeOperationSchema).min(1).max(100),
  })
  .strict();

export const SkillRevisionRequestSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-request/v1"),
    capabilityId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(50_000),
    source: z.enum(["user", "memory-learning"]),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    sourceRefs: z.array(SkillSourceRevisionRefSchema).max(100).default([]),
    replayCases: z.array(SkillReplayCaseSchema).min(3).max(10).optional(),
    boundaryCase: SkillReplayCaseSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.source === "memory-learning" &&
      (request.sourceDigest === undefined ||
        request.replayCases === undefined ||
        request.boundaryCase === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Memory Skill revisions require a digest and replay cases.",
      });
    }
  });

export const SkillRevisionJobStateSchema = z.enum([
  "pending",
  "running",
  "evaluating",
  "pending_review",
  "applying",
  "completed",
  "rejected",
  "needs_attention",
  "superseded",
]);

export const SkillRevisionJobSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-job/v1"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    request: SkillRevisionRequestSchema,
    state: SkillRevisionJobStateSchema,
    changeSet: SkillRevisionChangeSetSchema.optional(),
    evaluation: SkillEvaluationSnapshotSchema.optional(),
    supersededBy: z.string().uuid().optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const SkillRevisionJobRefSchema = z
  .object({ jobId: z.string().uuid(), expectedRevision: z.number().int().positive() })
  .strict();

export const ListSkillRevisionJobsSchema = z
  .object({
    capabilityId: z.string().uuid().optional(),
    state: SkillRevisionJobStateSchema.optional(),
  })
  .strict();

export type ContextStoreRevisionRequest = z.infer<typeof ContextStoreRevisionRequestSchema>;
export type ContextStoreRevisionProfile = z.infer<typeof ContextStoreRevisionProfileSchema>;
export type ContextStoreRevisionJob = z.infer<typeof ContextStoreRevisionJobSchema>;
export type ContextStoreRevisionSnapshot = z.infer<typeof ContextStoreRevisionSnapshotSchema>;
export type ContextStoreChangeSet = z.infer<typeof ContextStoreChangeSetSchema>;
export type ListContextStoreRevisionJobs = z.infer<typeof ListContextStoreRevisionJobsSchema>;
export type UpdateContextStoreRevisionProfile = z.infer<
  typeof UpdateContextStoreRevisionProfileSchema
>;
export type SkillRevisionChangeSet = z.infer<typeof SkillRevisionChangeSetSchema>;
export type SkillRevisionRequest = z.infer<typeof SkillRevisionRequestSchema>;
export type SkillRevisionJob = z.infer<typeof SkillRevisionJobSchema>;
export type ListSkillRevisionJobs = z.infer<typeof ListSkillRevisionJobsSchema>;
export type SkillEvaluationSnapshot = z.infer<typeof SkillEvaluationSnapshotSchema>;
export type SkillEvaluationProfile = z.infer<typeof SkillEvaluationProfileSchema>;
export type UpdateSkillEvaluationProfile = z.infer<typeof UpdateSkillEvaluationProfileSchema>;
