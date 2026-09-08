import { z } from "zod";

import {
  ContextStoreSchema,
  ContextStoreSnapshotSchema,
} from "../../../../shared/contracts/index.ts";

export const LegacyContextStoreV3Schema = z.object({
  schemaVersion: z.literal("pragma.context-store/v3"),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().max(500),
  type: z.literal("file"),
  status: z.enum(["ready", "needs_attention"]),
  source: z.object({ origin: z.enum(["created", "copied", "migrated"]) }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const LegacyContextStoreV4Schema = LegacyContextStoreV3Schema.extend({
  schemaVersion: z.literal("pragma.context-store/v4"),
  contentRevision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const LegacyContextStoreSnapshotV1Schema = z.object({
  schemaVersion: z.literal("pragma.context-store-snapshot/v1"),
  storeId: z.string().uuid(),
  revision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.string().datetime(),
  directories: z.array(z.string()),
  files: ContextStoreSnapshotSchema.shape.files,
});

export const LegacyContextStoreRevisionRecordSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-revision-record/v1"),
  storeId: z.string().uuid(),
  revision: z.number().int().positive(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  parentRevision: z.number().int().positive().nullable(),
  author: z.enum(["user", "import", "memory-initialization", "store-revision-agent", "migration"]),
  revisionJobId: z.string().uuid().optional(),
  summary: z.string().trim().min(1).max(2_000),
  createdAt: z.string().datetime(),
});

export const LegacyContextStoreV1Schema = z.object({
  schemaVersion: z.literal("pragma.context-store/v1"),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  type: z.enum(["file", "note"]),
  source: z
    .object({
      path: z.string().trim().min(1).max(2_000),
      updateBehavior: z.enum(["watch", "manual"]),
    })
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const LegacyContextStoreV2Schema = z.object({
  schemaVersion: z.literal("pragma.context-store/v2"),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  type: z.literal("file"),
  status: z.enum(["ready", "needs_attention"]),
  source: z.object({ origin: z.enum(["created", "copied", "migrated"]) }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ContextStoreMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v1"),
  targetSchema: z.literal("pragma.context-store/v2"),
  sourcePath: z.string().min(1),
  temporaryFiles: z.string().min(1),
  targetManifest: LegacyContextStoreV2Schema,
});

export const ContextStoreMigrationReadySchema = z.object({
  schemaVersion: z.literal("pragma.context-store-migration-ready/v1"),
  storeId: z.string().uuid(),
});

export const ContextStoreMetadataMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-metadata-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v2"),
  targetSchema: z.literal("pragma.context-store/v3"),
  targetManifest: LegacyContextStoreV3Schema,
});

export const ContextStoreV4MigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-v4-migration/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v3"),
  targetSchema: z.literal("pragma.context-store/v4"),
  targetManifest: LegacyContextStoreV4Schema,
  snapshot: LegacyContextStoreSnapshotV1Schema,
  record: LegacyContextStoreRevisionRecordSchema,
});

export const ContextStoreRevisionJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-revision-journal/v1"),
  storeId: z.string().uuid(),
  previousFilesPath: z.string().min(1),
  stagedFilesPath: z.string().min(1),
  targetManifest: LegacyContextStoreV4Schema,
  snapshot: LegacyContextStoreSnapshotV1Schema,
  record: LegacyContextStoreRevisionRecordSchema,
});

export const ContextStoreMutationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-mutation-journal/v1"),
  storeId: z.string().uuid(),
  previousFilesPath: z.string().min(1),
  stagedFilesPath: z.string().min(1),
  targetManifest: ContextStoreSchema,
  snapshot: ContextStoreSnapshotSchema,
});

export const ContextStoreV5MigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-v5-migration/v1"),
  storeId: z.string().uuid(),
  targetManifest: ContextStoreSchema,
  legacyRevisionsPath: z.string().min(1),
});

export const ContextStoreV3MigrationChainJournalSchema = z.object({
  schemaVersion: z.literal("pragma.context-store-v3-migration-chain/v1"),
  storeId: z.string().uuid(),
  sourceSchema: z.literal("pragma.context-store/v3"),
  targetSchema: z.literal("pragma.context-store/v5"),
  intermediateManifest: LegacyContextStoreV4Schema,
  targetManifest: ContextStoreSchema,
  snapshot: ContextStoreSnapshotSchema,
});
