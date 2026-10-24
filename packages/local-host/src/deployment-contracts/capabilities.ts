import { MAX_SKILL_PACKAGE_BYTES, SkillFilePathSchema } from "@pragma/shared";
export {
  CapabilityIdSchema,
  CapabilityRuntimeKeySchema,
  CapabilityToolNameSchema,
  CapabilityToolSnapshotSchema,
  SkillCapabilityDefinitionSchema,
  McpConnectionSchema,
  McpServerCapabilityDefinitionSchema,
  HttpServiceParameterSchema,
  HttpServiceToolSchema,
  HttpServiceAuthSchema,
  HttpServiceCapabilityDefinitionSchema,
  type CodeServiceJsonSchema,
  CodeServiceJsonSchemaSchema,
  CodeServiceObjectJsonSchemaSchema,
  CodeServiceCapabilityDefinitionSchema,
  CapabilityDefinitionSchema,
  CapabilityManifestSchema,
  CapabilityHealthSchema,
  CapabilitySchema,
  ExpertCapabilityReferenceSchema,
} from "@pragma/shared";
import {
  CapabilityIdSchema,
  CapabilityToolNameSchema,
  McpServerCapabilityDefinitionSchema,
  HttpServiceCapabilityDefinitionSchema,
  CodeServiceCapabilityDefinitionSchema,
  CapabilitySchema,
  capabilityNameSchema,
  capabilityDescriptionSchema,
} from "@pragma/shared";
import { PragmaExpertInstructionsSchema, PragmaExpertScopeSchema } from "@pragma/interpreter/ast";
import { PRAGMA_TEXT_LIMITS, pragmaUnicodeLength } from "@pragma/shared";
import { z } from "zod";
import { ModelIdSchema } from "./model-provider.ts";
import { DesktopRuntimeIdSchema } from "./runtime.ts";
export { PragmaExpertIdSchema } from "@pragma/interpreter/ast";
export const ExpertScopeSchema = PragmaExpertScopeSchema;
export const ExpertInstructionsSchema = PragmaExpertInstructionsSchema;
export const ExpertAdditionalInstructionsSchema = z
  .string()
  .refine(
    (value) => pragmaUnicodeLength(value) <= PRAGMA_TEXT_LIMITS.expert.instructions,
    `Must contain at most ${PRAGMA_TEXT_LIMITS.expert.instructions} characters.`,
  )
  .default("");
export const ExpertModelConfigSchema = z.object({
  permissionModeId: z.string().trim().min(1).max(100).optional(),
  runtimeId: DesktopRuntimeIdSchema,
  providerId: z.string().trim().min(1).max(200),
  modelId: ModelIdSchema,
  thinkingLevel: z.string().trim().min(1).max(100).optional(),
});
export const ImportSkillCapabilitySchema = z.object({
  sourcePath: z.string().trim().min(1).max(2000),
  name: capabilityNameSchema().optional(),
  description: capabilityDescriptionSchema(true).optional(),
});
export const SubmitSkillRevisionSchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    prompt: z.string().trim().min(1).max(50000),
  })
  .strict();
export const ImportSkillRevisionSchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    sourcePath: z.string().trim().min(1).max(2000),
  })
  .strict();
export const CreateCapabilitySchema = z
  .object({
    definition: z.union([
      McpServerCapabilityDefinitionSchema,
      HttpServiceCapabilityDefinitionSchema,
      CodeServiceCapabilityDefinitionSchema,
    ]),
    credentials: z.record(z.string().max(200), z.string().min(1).max(10000)).default({}),
  })
  .superRefine(addCodeCredentialIssue);
export const UpdateCapabilitySchema = z
  .object({
    id: CapabilityIdSchema,
    baseRevision: z.number().int().positive(),
    definition: z.union([
      McpServerCapabilityDefinitionSchema,
      HttpServiceCapabilityDefinitionSchema,
      CodeServiceCapabilityDefinitionSchema,
    ]),
    credentials: z.record(z.string().max(200), z.string().min(1).max(10000)).default({}),
  })
  .superRefine(addCodeCredentialIssue);
function addCodeCredentialIssue(
  input: {
    readonly definition: {
      readonly kind: string;
    };
    readonly credentials: Readonly<Record<string, string>>;
  },
  context: z.RefinementCtx,
): void {
  if (input.definition.kind === "code_service" && Object.keys(input.credentials).length > 0) {
    context.addIssue({
      code: "custom",
      message: "Code services cannot receive credentials.",
      path: ["credentials"],
    });
  }
}
export const CapabilityActionSchema = z.object({ id: CapabilityIdSchema });
export const CapabilityRevisionActionSchema = CapabilityActionSchema.extend({
  expectedRevision: z.number().int().positive(),
});
export const CapabilityDeleteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.literal("capability_referenced"),
  }),
]);
export const GetSkillDocumentSchema = z.object({
  id: CapabilityIdSchema,
  revision: z.number().int().positive().optional(),
});
export const SkillDocumentSchema = z.object({
  capabilityId: CapabilityIdSchema,
  revision: z.number().int().positive(),
  entryPath: z.literal("SKILL.md"),
  content: z.string(),
});
export const ListSkillFilesSchema = GetSkillDocumentSchema.extend({
  includeDirectories: z.boolean().optional(),
});
export const SkillFileEntrySchema = z.object({
  kind: z.enum(["file", "directory"]).optional(),
  path: SkillFilePathSchema,
  size: z.number().int().nonnegative(),
});
export const GetSkillFileSchema = GetSkillDocumentSchema.extend({
  path: SkillFilePathSchema,
});
export const SkillFileContentSchema = SkillFileEntrySchema.extend({
  capabilityId: CapabilityIdSchema,
  revision: z.number().int().positive(),
  content: z.string().nullable(),
});
export const SkillFileOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create-file"), path: SkillFilePathSchema }).strict(),
  z.object({ kind: z.literal("create-directory"), path: SkillFilePathSchema }).strict(),
  z
    .object({ kind: z.literal("move"), path: SkillFilePathSchema, nextPath: SkillFilePathSchema })
    .strict(),
  z.object({ kind: z.literal("delete"), path: SkillFilePathSchema }).strict(),
]);
export const SaveSkillFilesSchema = z
  .object({
    id: CapabilityIdSchema,
    baseRevision: z.number().int().positive(),
    files: z
      .array(
        z
          .object({
            path: SkillFilePathSchema,
            content: z.string().max(MAX_SKILL_PACKAGE_BYTES),
          })
          .strict(),
      )
      .max(1000),
    operations: z.array(SkillFileOperationSchema).max(1000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.files.length === 0 && (input.operations?.length ?? 0) === 0)
      context.addIssue({ code: "custom", message: "No Skill changes were supplied." });
    const encoder = new TextEncoder();
    if (
      input.files.reduce((total, file) => total + encoder.encode(file.content).byteLength, 0) >
      MAX_SKILL_PACKAGE_BYTES
    )
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Skill edits exceed the package size limit.",
      });
    if (new Set(input.files.map((file) => file.path)).size !== input.files.length)
      context.addIssue({ code: "custom", path: ["files"], message: "Duplicate Skill file paths." });
  });

export const SkillRevisionReviewFileMetadataSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  executable: z.boolean(),
});
export const SkillRevisionFileChangeSchema = z.object({
  path: SkillFilePathSchema,
  operation: z.enum(["added", "modified", "deleted"]),
  before: SkillRevisionReviewFileMetadataSchema.nullable(),
  after: SkillRevisionReviewFileMetadataSchema.nullable(),
});
export const SkillRevisionReviewSchema = z.object({
  jobId: z.string().uuid(),
  draftId: z.string().uuid(),
  baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  candidateSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  operations: z.array(SkillRevisionFileChangeSchema).max(2000),
});
export const GetSkillRevisionReviewFileSchema = z.object({
  jobId: z.string().uuid(),
  path: SkillFilePathSchema,
});
export const SkillRevisionReviewFileSnapshotSchema = SkillRevisionReviewFileMetadataSchema.extend({
  content: z.string().max(1000000).nullable(),
  unavailableReason: z.enum(["binary", "size_limit", "line_limit"]).nullable(),
});
export const SkillRevisionReviewFileSchema = z.object({
  jobId: z.string().uuid(),
  path: SkillFilePathSchema,
  before: SkillRevisionReviewFileSnapshotSchema.nullable(),
  after: SkillRevisionReviewFileSnapshotSchema.nullable(),
});
export const SkillManualRevisionRecordSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-manual-revision/v1"),
    capabilityId: CapabilityIdSchema,
    revision: z.number().int().min(2),
    baseRevision: z.number().int().positive(),
    name: z.string().min(1),
    source: z.literal("manual"),
    createdAt: z.string().datetime(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    operations: z.array(
      SkillRevisionFileChangeSchema.extend({ entryKind: z.enum(["file", "directory"]) }),
    ),
  })
  .strict()
  .refine(
    (record) => record.revision === record.baseRevision + 1,
    "Skill revision parent mismatch.",
  );
export const ListSkillManualRevisionsSchema = z
  .object({ capabilityId: CapabilityIdSchema.optional() })
  .strict();
export const GetSkillManualRevisionFileSchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    revision: z.number().int().min(2),
    path: SkillFilePathSchema,
  })
  .strict();
export const SkillManualRevisionFileSchema = z.object({
  capabilityId: CapabilityIdSchema,
  revision: z.number().int().min(2),
  path: SkillFilePathSchema,
  before: SkillRevisionReviewFileSnapshotSchema.nullable(),
  after: SkillRevisionReviewFileSnapshotSchema.nullable(),
});
export const CapabilityTestRequestSchema = z.object({
  id: CapabilityIdSchema,
  expectedRevision: z.number().int().positive(),
  toolName: CapabilityToolNameSchema.optional(),
  input: z.unknown().optional(),
});
export const CapabilityTestResultSchema = z.object({
  ok: z.boolean(),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  capability: CapabilitySchema,
  output: z.unknown().optional(),
});
export const PreviewCodeServiceRequestSchema = z.object({
  definition: CodeServiceCapabilityDefinitionSchema,
  input: z.unknown(),
});
export const PreviewCodeServiceResultSchema = z.object({
  ok: z.boolean(),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  output: z.record(z.string(), z.unknown()).optional(),
});
