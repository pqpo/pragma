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

function entryNameFromId(id: string, kind: "file" | "directory"): string {
  const segment = id.replaceAll("\\", "/").replace(/\/+$/u, "").split("/").at(-1) ?? "";
  return kind === "file" ? segment.replace(/\.md$/iu, "") : segment;
}

function hasValidEntryName(id: string, kind: "file" | "directory"): boolean {
  return pragmaKnowledgeBaseEntryNameIssue(entryNameFromId(id, kind)) === undefined;
}

const ManagedFolderIdSchema = ContextStoreEntryIdSchema.refine(
  (id) => hasValidEntryName(id, "directory"),
  { message: "The folder name is not portable or exceeds 100 characters." },
);
const ManagedFileIdSchema = ContextStoreEntryIdSchema.refine(
  (id) => hasValidEntryName(id, "file"),
  { message: "The file name is not portable or exceeds 100 characters." },
);

const ContextStoreBaseSchema = z.object({
  schemaVersion: z.literal("pragma.context-store/v3"),
  id: ContextStoreIdSchema,
  name: KnowledgeBaseNameSchema,
  description: KnowledgeBaseDescriptionSchema,
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
