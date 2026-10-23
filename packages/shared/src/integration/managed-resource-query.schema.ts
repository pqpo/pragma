import { z } from "zod";
import { CapabilityIdSchema, SkillFilePathSchema } from "../resources/capability.schema.ts";
import { ContextStoreSnapshotFileSchema } from "../resources/context-store.schema.ts";
import { JsonObjectSchema, OpaqueCursorSchema } from "./primitives.schema.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Revision = z.number().int().positive();
const Query = z.string().trim().min(1).max(200).optional();
const Status = z.enum(["ready", "needs_attention"]);
const DocumentId = ContextStoreSnapshotFileSchema.shape.id;
export const ManagedResourcePageInputSchema = z
  .object({
    cursor: OpaqueCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export const ManagedResourceRangeInputSchema = z
  .object({
    expectedSha256: Hash.optional().describe(
      "Expected full text hash; copied automatically by continuation.",
    ),
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("UTF-16 offset. Copy continuation.input instead of calculating offsets."),
    limitChars: z.number().int().min(1).max(100_000).default(20_000),
  })
  .strict();
export const ManagedSkillTargetSchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    revision: z
      .union([Revision, z.literal("active")])
      .optional()
      .describe("Omit for the latest formal revision; active selects the Runtime revision."),
    contentHash: Hash.optional().describe(
      "Expected package hash returned by discovery or a previous read.",
    ),
  })
  .strict();
export const ManagedKnowledgeTargetSchema = z
  .object({
    storeId: z.string().uuid(),
    revision: Revision.optional(),
    snapshotHash: Hash.optional(),
  })
  .strict();
export const ManagedKnowledgeListInputSchema = ManagedResourcePageInputSchema.extend({
  query: Query,
  status: Status.optional(),
});
export const ManagedSkillListInputSchema = ManagedResourcePageInputSchema.extend({
  query: Query,
  status: Status.optional(),
  managedBy: z.enum(["system", "user"]).optional(),
});
export const ManagedSkillGetInputSchema = ManagedSkillTargetSchema.extend({
  view: z.enum(["summary", "content", "definition"]).default("summary"),
  ...ManagedResourceRangeInputSchema.shape,
});
export const ManagedSkillFilesInputSchema = ManagedSkillTargetSchema.extend({
  ...ManagedResourcePageInputSchema.shape,
  query: Query,
});
export const ManagedSkillReadInputSchema = ManagedSkillTargetSchema.extend({
  path: SkillFilePathSchema,
  ...ManagedResourceRangeInputSchema.shape,
});
export const ManagedKnowledgeGetInputSchema = ManagedKnowledgeTargetSchema.extend({
  view: z.enum(["summary", "definition"]).default("summary"),
  ...ManagedResourceRangeInputSchema.shape,
});
export const ManagedKnowledgeDocumentsInputSchema = ManagedKnowledgeTargetSchema.extend({
  ...ManagedResourcePageInputSchema.shape,
  query: Query,
});
export const ManagedKnowledgeSearchInputSchema = ManagedKnowledgeDocumentsInputSchema.extend({
  query: z.string().trim().min(1).max(200),
  scope: z.enum(["path", "content", "all"]).default("all"),
});
export const ManagedKnowledgeReadInputSchema = ManagedKnowledgeTargetSchema.extend({
  documentId: DocumentId,
  ...ManagedResourceRangeInputSchema.shape,
});

export const ManagedResourceCommandSchema = z.enum([
  "skill.list",
  "skill.get",
  "skill.files.list",
  "skill.files.read",
  "knowledge-store.get",
  "knowledge-store.documents.list",
  "knowledge-store.documents.search",
  "knowledge-store.documents.read",
]);
export const ManagedResourceContinuationSchema = z
  .object({
    command: ManagedResourceCommandSchema,
    input: JsonObjectSchema,
  })
  .strict();
export const ManagedResourceContentSchema = z
  .object({
    content: z.string().nullable(),
    readable: z.boolean(),
    unavailableReason: z.enum(["binary_or_unsupported_encoding"]).optional(),
    offset: z.number().int().nonnegative(),
    totalChars: z.number().int().nonnegative(),
    sha256: Hash.optional(),
    complete: z.boolean(),
  })
  .strict();
export const ManagedSkillSummarySchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    name: z.string(),
    description: z.string(),
    managedBy: z.enum(["system", "user"]),
    status: Status,
    latestRevision: Revision,
    activeRevision: Revision.nullable(),
    revision: Revision,
    contentHash: Hash,
  })
  .strict();
export const ManagedKnowledgeSummarySchema = z
  .object({
    storeId: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    type: z.literal("file"),
    status: Status,
    revision: Revision,
    snapshotHash: Hash,
    writeApprovalMode: z.enum(["required", "auto"]),
  })
  .strict();
const Page = z
  .object({
    schemaVersion: z.literal("pragma.managed-resource-page/v1"),
    nextCursor: OpaqueCursorSchema.optional(),
    continuation: ManagedResourceContinuationSchema.optional(),
  })
  .strict();
const SkillIdentity = ManagedSkillTargetSchema.required({
  revision: true,
  contentHash: true,
}).extend({ revision: Revision });
const KnowledgeIdentity = ManagedKnowledgeTargetSchema.required();
export const ManagedSkillPageSchema = Page.extend({
  items: z.array(ManagedSkillSummarySchema).max(100),
});
export const ManagedSkillFilesPageSchema = Page.extend({
  ...SkillIdentity.shape,
  items: z
    .array(
      z
        .object({
          path: SkillFilePathSchema,
          size: z.number().int().nonnegative().describe("File size in bytes."),
          isDirectory: z.boolean().optional(),
        })
        .strict(),
    )
    .max(100),
});
export const ManagedSkillDetailSchema = ManagedSkillSummarySchema.extend({
  schemaVersion: z.literal("pragma.managed-skill/v1"),
  view: z.enum(["summary", "content", "definition"]),
  path: SkillFilePathSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dslRefs: z.array(z.string()).optional(),
  data: ManagedResourceContentSchema.optional(),
  continuation: ManagedResourceContinuationSchema.optional(),
});
export const ManagedSkillFileSchema = SkillIdentity.extend({
  schemaVersion: z.literal("pragma.managed-skill-file/v1"),
  path: SkillFilePathSchema,
  sizeBytes: z.number().int().nonnegative(),
  data: ManagedResourceContentSchema,
  continuation: ManagedResourceContinuationSchema.optional(),
});
export const ManagedKnowledgeDetailSchema = ManagedKnowledgeSummarySchema.extend({
  schemaVersion: z.literal("pragma.managed-knowledge-store/v1"),
  view: z.enum(["summary", "definition"]),
  dslRefs: z.array(z.string()).optional(),
  data: ManagedResourceContentSchema.optional(),
  continuation: ManagedResourceContinuationSchema.optional(),
});
const DocumentSummary = z
  .object({
    documentId: DocumentId,
    description: z.string(),
    sizeChars: z.number().int().nonnegative(),
  })
  .strict();
export const ManagedKnowledgeDocumentsPageSchema = Page.extend({
  ...KnowledgeIdentity.shape,
  items: z.array(DocumentSummary).max(100),
});
export const ManagedKnowledgeSearchPageSchema = Page.extend({
  ...KnowledgeIdentity.shape,
  items: z
    .array(
      z
        .object({
          documentId: DocumentId,
          matchType: z.enum(["path", "content"]),
          line: z.number().int().positive().optional(),
          snippet: z.string(),
        })
        .strict(),
    )
    .max(100),
});
export const ManagedKnowledgeDocumentSchema = KnowledgeIdentity.extend({
  schemaVersion: z.literal("pragma.managed-knowledge-document/v1"),
  documentId: DocumentId,
  metadata: JsonObjectSchema,
  data: ManagedResourceContentSchema,
  continuation: ManagedResourceContinuationSchema.optional(),
});

export const MANAGED_RESOURCE_QUERY_SCHEMAS = {
  "skill.list": { input: ManagedSkillListInputSchema, output: ManagedSkillPageSchema },
  "skill.get": { input: ManagedSkillGetInputSchema, output: ManagedSkillDetailSchema },
  "skill.files.list": { input: ManagedSkillFilesInputSchema, output: ManagedSkillFilesPageSchema },
  "skill.files.read": { input: ManagedSkillReadInputSchema, output: ManagedSkillFileSchema },
  "knowledge-store.get": {
    input: ManagedKnowledgeGetInputSchema,
    output: ManagedKnowledgeDetailSchema,
  },
  "knowledge-store.documents.list": {
    input: ManagedKnowledgeDocumentsInputSchema,
    output: ManagedKnowledgeDocumentsPageSchema,
  },
  "knowledge-store.documents.search": {
    input: ManagedKnowledgeSearchInputSchema,
    output: ManagedKnowledgeSearchPageSchema,
  },
  "knowledge-store.documents.read": {
    input: ManagedKnowledgeReadInputSchema,
    output: ManagedKnowledgeDocumentSchema,
  },
} as const;
export type ManagedResourceCommand = z.infer<typeof ManagedResourceCommandSchema>;
export type ManagedResourceQuery = {
  [C in ManagedResourceCommand]: {
    command: C;
    input: z.input<(typeof MANAGED_RESOURCE_QUERY_SCHEMAS)[C]["input"]>;
  };
}[ManagedResourceCommand];
export type ManagedResourceQueryResult = z.infer<
  (typeof MANAGED_RESOURCE_QUERY_SCHEMAS)[ManagedResourceCommand]["output"]
>;
export type ManagedResourceContinuation = z.infer<typeof ManagedResourceContinuationSchema>;
