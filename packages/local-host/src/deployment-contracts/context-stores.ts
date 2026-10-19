export {
  CONTEXT_STORE_FILE_MAX_BYTES,
  ContextStoreIdSchema,
  FileContextStoreSchema,
  ContextStoreSchema,
  ContextStoreSnapshotFileSchema,
  ContextStoreSnapshotSchema,
  ContextStoreChangeOperationSchema,
  ContextStoreChangeSetSchema,
  ContextStoreRevisionRecordSchema,
  GetContextStoreRevisionDiffSchema,
  ContextStoreRevisionDiffSchema,
  ListContextStoreRevisionRecordsSchema,
  DeleteContextStoreRevisionRecordSchema,
  CreateContextStoreSchema,
  InspectContextStoreImportSchema,
  ContextStoreImportInspectionSchema,
  DeleteContextStoreSchema,
  ContextStoreMissionMountCheckSchema,
  ContextStoreMissionMountCheckResultSchema,
  ContextStoreContentMetadataSchema,
  ContextStoreContentSummarySchema,
  ContextStoreContentSchema,
  GetContextStoreContentSchema,
  ContextStoreEntrySchema,
  ListContextStoreEntriesSchema,
  CreateContextStoreFolderSchema,
  CreateContextStoreFileSchema,
  UpdateContextStoreFileSchema,
  RenameContextStoreEntrySchema,
  DeleteContextStoreEntrySchema,
} from "@pragma/shared";
import { ContextStoreIdSchema } from "@pragma/shared";
import { ContextStoreDraftOverlaySchema } from "@pragma/built-in-agents/contracts";
import { z } from "zod";
export const ContextStoreEditorDraftSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-editor-draft/v1"),
    revision: z.number().int().positive(),
    storeId: ContextStoreIdSchema,
    baseRevision: z.number().int().positive(),
    baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    overlay: ContextStoreDraftOverlaySchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const GetContextStoreEditorDraftSchema = z.object({ storeId: ContextStoreIdSchema });

export const CommitContextStoreEditorDraftSchema = z.object({
  storeId: ContextStoreIdSchema,
  expectedRevision: z.number().int().positive(),
});

export const DiscardContextStoreEditorDraftSchema = CommitContextStoreEditorDraftSchema;

export const SubscribeContextStoreChangesSchema = z.object({
  storeId: ContextStoreIdSchema,
});

export const ExpertContextStoreMountSchema = z.object({
  storeId: ContextStoreIdSchema,
  enabled: z.boolean(),
  priority: z.number().int().nonnegative(),
});
