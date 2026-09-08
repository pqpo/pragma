import {
  ContextTriggerSchema,
  PRAGMA_TEXT_LIMITS,
  pragmaKnowledgeBaseEntryNameIssue,
  pragmaUnicodeLength,
} from "@pragma/shared";
import { z } from "zod";

export const ContextStoreIdSchema = z.string().uuid();

const KnowledgeBaseNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => pragmaUnicodeLength(value) <= PRAGMA_TEXT_LIMITS.contextStore.name, {
    message: `Must contain at most ${PRAGMA_TEXT_LIMITS.contextStore.name} characters.`,
  });
const KnowledgeBaseDescriptionSchema = z
  .string()
  .trim()
  .refine((value) => pragmaUnicodeLength(value) <= PRAGMA_TEXT_LIMITS.contextStore.description, {
    message: `Must contain at most ${PRAGMA_TEXT_LIMITS.contextStore.description} characters.`,
  });

const ContextStoreEntryIdSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value.trim().length > 0, { message: "Entry path is required." });

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

// Historical v3 imports accepted every safe Markdown path supported by the host filesystem.
// Revision snapshots must remain able to describe that data even when a name is not portable for
// newly-created entries.
const StoredDirectoryIdSchema = z
  .string()
  .min(1)
  .refine((id) => isSafeRelativeEntryId(id, "directory"), {
    message: "Directory path must stay inside the knowledge base.",
  });
const StoredMarkdownFileIdSchema = z
  .string()
  .min(1)
  .refine((id) => isSafeRelativeEntryId(id, "file"), {
    message: "File path must be a relative Markdown path inside the knowledge base.",
  });

function entryNameFromId(id: string, kind: "file" | "directory"): string {
  const segment = id.replaceAll("\\", "/").replace(/\/+$/u, "").split("/").at(-1) ?? "";
  return kind === "file" ? segment.replace(/\.md$/iu, "") : segment;
}

function hasValidEntryName(id: string, kind: "file" | "directory"): boolean {
  return pragmaKnowledgeBaseEntryNameIssue(entryNameFromId(id, kind)) === undefined;
}

const ManagedFolderIdSchema = ContextStoreEntryIdSchema.refine(
  (id) => isSafeRelativeEntryId(id, "directory") && hasValidEntryName(id, "directory"),
  { message: "The folder name is not portable or exceeds 100 characters." },
);
const ManagedFileIdSchema = ContextStoreEntryIdSchema.refine(
  (id) => isSafeRelativeEntryId(id, "file") && hasValidEntryName(id, "file"),
  { message: "The file name is not portable or exceeds 100 characters." },
);

const ContextStoreBaseSchema = z.object({
  schemaVersion: z.literal("pragma.context-store/v4"),
  id: ContextStoreIdSchema,
  name: KnowledgeBaseNameSchema,
  description: KnowledgeBaseDescriptionSchema,
  contentRevision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const FileContextStoreSchema = ContextStoreBaseSchema.extend({
  type: z.literal("file"),
  status: z.enum(["ready", "needs_attention"]),
  source: z.object({
    origin: z.enum(["created", "copied", "migrated"]),
  }),
});

export const ContextStoreSchema = FileContextStoreSchema;

export const ContextStoreSnapshotFileSchema = z.object({
  id: StoredMarkdownFileIdSchema,
  content: z.string().max(1_000_000),
  metadata: z.lazy(() => ContextStoreContentMetadataSchema),
});

export const ContextStoreSnapshotSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-snapshot/v1"),
    storeId: ContextStoreIdSchema,
    revision: z.number().int().positive(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.string().datetime(),
    directories: StoredDirectoryIdSchema.array().default([]),
    files: ContextStoreSnapshotFileSchema.array(),
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

const ContextStoreUpsertOperationSchema = z.object({
  operation: z.literal("upsert"),
  id: ManagedFileIdSchema,
  previousContent: z.string().max(1_000_000).optional(),
  content: z.string().max(1_000_000),
  metadata: z.lazy(() => ContextStoreContentMetadataSchema),
});

const ContextStoreDeleteOperationSchema = z.object({
  operation: z.literal("delete"),
  id: StoredMarkdownFileIdSchema,
  previousContent: z.string().max(1_000_000).optional(),
});

const ContextStoreRenameOperationSchema = z.object({
  operation: z.literal("rename"),
  id: StoredMarkdownFileIdSchema,
  nextId: ManagedFileIdSchema,
});

export const ContextStoreChangeOperationSchema = z.discriminatedUnion("operation", [
  ContextStoreUpsertOperationSchema,
  ContextStoreDeleteOperationSchema,
  ContextStoreRenameOperationSchema,
]);

export const ContextStoreChangeSetSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-change-set/v1"),
  storeId: ContextStoreIdSchema,
  baseRevision: z.number().int().positive(),
  baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.string().trim().min(1).max(2_000),
  operations: ContextStoreChangeOperationSchema.array().min(1).max(1_000),
});

export const ContextStoreRevisionRecordSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-revision-record/v1"),
  storeId: ContextStoreIdSchema,
  revision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  parentRevision: z.number().int().positive().nullable(),
  author: z.enum(["user", "import", "memory-initialization", "store-revision-agent", "migration"]),
  revisionJobId: z.string().uuid().optional(),
  summary: z.string().trim().min(1).max(2_000),
  createdAt: z.string().datetime(),
});

const CreateContextStoreBaseShape = {
  name: KnowledgeBaseNameSchema,
  description: KnowledgeBaseDescriptionSchema,
};

export const CreateContextStoreSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("blank"),
    ...CreateContextStoreBaseShape,
  }),
  z.object({
    mode: z.literal("import"),
    ...CreateContextStoreBaseShape,
    sourcePath: z.string().trim().min(1).max(2_000),
  }),
]);

export const InspectContextStoreImportSchema = z.object({
  sourcePath: z.string().trim().min(1).max(2_000),
});

export const ContextStoreImportInspectionSchema = z.object({
  sourcePath: z.string().trim().min(1).max(2_000),
  markdownFiles: z.number().int().nonnegative(),
  ignoredFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

export const DeleteContextStoreSchema = z.object({
  storeId: ContextStoreIdSchema,
});

export const ContextStoreContentMetadataSchema = z.object({
  description: z.string().max(2_000).optional(),
  trigger: ContextTriggerSchema,
  trustLevel: z.enum(["system", "workspace", "user", "external"]).optional(),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  priority: z.enum(["critical", "high", "normal", "low"]),
});

export const ContextStoreContentSummarySchema = z.object({
  id: z.string().trim().min(1).max(2_000),
  metadata: ContextStoreContentMetadataSchema,
  revision: z.string().max(500).optional(),
  etag: z.string().max(500).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const ContextStoreContentSchema = ContextStoreContentSummarySchema.extend({
  content: z.string().max(1_000_000),
  truncated: z.boolean(),
});

export const GetContextStoreContentSchema = z.object({
  storeId: ContextStoreIdSchema,
  contentId: z.string().trim().min(1).max(2_000),
});

export const ContextStoreEntrySchema = z.object({
  id: z.string().trim().min(1).max(2_000),
  kind: z.enum(["file", "directory"]),
  sizeBytes: z.number().int().nonnegative().optional(),
  revision: z.string().max(500).optional(),
});

export const ListContextStoreEntriesSchema = z.object({
  storeId: ContextStoreIdSchema,
});

export const CreateContextStoreFolderSchema = z.object({
  storeId: ContextStoreIdSchema,
  id: ManagedFolderIdSchema,
});

export const CreateContextStoreFileSchema = z.object({
  storeId: ContextStoreIdSchema,
  id: ManagedFileIdSchema,
  content: z.string().max(1_000_000).default(""),
  metadata: ContextStoreContentMetadataSchema.optional(),
});

export const UpdateContextStoreFileSchema = z.object({
  storeId: ContextStoreIdSchema,
  id: z.string().trim().min(1).max(2_000),
  content: z.string().max(1_000_000),
  metadata: ContextStoreContentMetadataSchema,
  expectedRevision: z.string().trim().min(1).max(500),
});

export const RenameContextStoreEntrySchema = z
  .object({
    storeId: ContextStoreIdSchema,
    id: ContextStoreEntryIdSchema,
    nextId: ContextStoreEntryIdSchema,
    kind: z.enum(["file", "directory"]),
  })
  .superRefine((value, context) => {
    const currentName = value.id.replaceAll("\\", "/").split("/").at(-1) ?? "";
    const nextName = value.nextId.replaceAll("\\", "/").split("/").at(-1) ?? "";
    if (currentName === nextName || hasValidEntryName(value.nextId, value.kind)) return;
    context.addIssue({
      code: "custom",
      path: ["nextId"],
      message: "The new entry name is not portable or exceeds 100 characters.",
    });
  });

export const DeleteContextStoreEntrySchema = z.object({
  storeId: ContextStoreIdSchema,
  id: z.string().trim().min(1).max(2_000),
  kind: z.enum(["file", "directory"]),
});

export const SubscribeContextStoreChangesSchema = z.object({
  storeId: ContextStoreIdSchema,
});

export const ExpertContextStoreMountSchema = z.object({
  storeId: ContextStoreIdSchema,
  enabled: z.boolean(),
  priority: z.number().int().nonnegative(),
});
