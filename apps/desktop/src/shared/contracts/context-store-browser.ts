import { z } from "zod";

import { ContextStoreContentMetadataSchema } from "./context-stores.ts";
import { MissionIdSchema } from "./mission-base.ts";

export const MissionContextStoreIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9-]*$/);

export const MissionContextStoreScopeIdSchema = z.string().trim().min(1).max(200);

export const MissionContextStoreScopeSchema = z.object({
  id: MissionContextStoreScopeIdSchema,
  expertId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  role: z.enum(["root", "coordinator", "member", "flow-step", "delegated", "observed"]),
  participation: z.enum(["participated", "available"]),
  availability: z.enum(["available", "recall_disabled"]),
});

export const MissionContextStoreDescriptorSchema = z.object({
  schemaVersion: z.literal("pragma.desktop-mission-context-store/v1"),
  missionId: MissionIdSchema,
  storeId: MissionContextStoreIdSchema,
  namespace: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  readOnly: z.boolean(),
  searchable: z.boolean(),
  root: z.object({
    type: z.enum(["pragma.expert", "pragma.expert-team", "pragma.flow"]),
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
  }),
  defaultScopeId: MissionContextStoreScopeIdSchema,
  scopes: z.array(MissionContextStoreScopeSchema).min(1).max(500),
});

const MissionContextStoreTargetShape = {
  missionId: MissionIdSchema,
  storeId: MissionContextStoreIdSchema,
  scopeId: MissionContextStoreScopeIdSchema,
};

export const GetMissionContextStoreSchema = z.object({
  missionId: MissionIdSchema,
  storeId: MissionContextStoreIdSchema,
});

export const ListMissionContextStoreEntriesSchema = z.object(MissionContextStoreTargetShape);

export const MissionContextStoreEntrySchema = z.object({
  id: z.string().trim().min(1).max(2_000),
  metadata: ContextStoreContentMetadataSchema,
  revision: z.string().max(500).optional(),
  etag: z.string().max(500).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const ReadMissionContextStoreEntrySchema = z.object({
  ...MissionContextStoreTargetShape,
  id: z.string().trim().min(1).max(2_000),
  start: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().positive().max(64_000).default(64_000),
});

export const MissionContextStoreContentSchema = MissionContextStoreEntrySchema.extend({
  content: z.string().max(64_000),
  contentRange: z.object({
    requestedStartOffset: z.number().int().nonnegative(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    nextStartOffset: z.number().int().nonnegative(),
    truncated: z.boolean(),
    sizeBytes: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    totalLines: z.number().int().positive().optional(),
  }),
});

export const SearchMissionContextStoreSchema = z.object({
  ...MissionContextStoreTargetShape,
  query: z.string().trim().min(1).max(1_000),
  maxResults: z.number().int().positive().max(50).default(50),
  contextLines: z.number().int().nonnegative().max(2).default(2),
});

export const MissionContextStoreSearchMatchSchema = z.object({
  id: z.string().trim().min(1).max(2_000),
  matchType: z.enum(["path", "content"]).optional(),
  lineNumber: z.number().int().positive().optional(),
  line: z.string().max(10_000),
  before: z.array(z.string().max(10_000)).max(2).optional(),
  after: z.array(z.string().max(10_000)).max(2).optional(),
});
