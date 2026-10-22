import { z } from "zod";
import {
  PRAGMA_TEXT_LIMITS,
  pragmaUnicodeLength,
  ContextStoreSnapshotSchema,
  ContextStoreRevisionRecordSchema,
} from "@pragma/shared";
const ContextStoreIdSchema = z.string().uuid();
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

export const ContextStoreV4Schema = FileContextStoreSchema;

export const ContextStoreRevisionJournalV1Schema = z.object({
  schemaVersion: z.literal("pragma.context-store-revision-journal/v1"),
  storeId: z.string().uuid(),
  previousFilesPath: z.string().min(1),
  stagedFilesPath: z.string().min(1),
  targetManifest: ContextStoreV4Schema,
  snapshot: ContextStoreSnapshotSchema,
  record: ContextStoreRevisionRecordSchema,
});
