import { ContextTriggerSchema } from "@pragma/shared";
import { z } from "zod";

export const ContextStoreIdSchema = z.string().uuid();

const ContextStoreBaseSchema = z.object({
  schemaVersion: z.literal("pragma.context-store/v2"),
  id: ContextStoreIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
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

const CreateContextStoreBaseShape = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
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
  id: z.string().trim().min(1).max(2_000),
});

export const CreateContextStoreFileSchema = z.object({
  storeId: ContextStoreIdSchema,
  id: z.string().trim().min(1).max(2_000),
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

export const RenameContextStoreEntrySchema = z.object({
  storeId: ContextStoreIdSchema,
  id: z.string().trim().min(1).max(2_000),
  nextId: z.string().trim().min(1).max(2_000),
  kind: z.enum(["file", "directory"]),
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
