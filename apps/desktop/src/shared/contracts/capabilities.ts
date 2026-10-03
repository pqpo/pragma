import { SkillFilePathSchema } from "@pragma/shared";
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
export const ListSkillFilesSchema = GetSkillDocumentSchema;
export const SkillFileEntrySchema = z.object({
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
export const SkillRevisionReviewFileMetadataSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  executable: z.boolean(),
});
export const SkillRevisionReviewSchema = z.object({
  jobId: z.string().uuid(),
  draftId: z.string().uuid(),
  baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  candidateSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  operations: z
    .array(
      z.object({
        path: SkillFilePathSchema,
        operation: z.enum(["added", "modified", "deleted"]),
        before: SkillRevisionReviewFileMetadataSchema.nullable(),
        after: SkillRevisionReviewFileMetadataSchema.nullable(),
      }),
    )
    .max(2000),
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
