import { z } from "zod";
import { MemoryExtractionFailureDiagnosticSchema } from "./extraction-failure.schema.ts";

import {
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryVisibilityPolicySchema,
} from "./memory-plane.schema.ts";

export const SKILL_LEARNING_JOB_SCHEMA_VERSION = "pragma.memory-skill-job/v2" as const;
export const SKILL_EXTRACTION_INPUT_SCHEMA_VERSION =
  "pragma.memory-skill-extraction-input/v1" as const;

export const SkillSourceRevisionRefSchema = z
  .object({
    kind: z.enum(["episodic", "semantic", "knowledge"]),
    id: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

export const SkillReplayExpectationSchema = z
  .object({
    objective: z.string().trim().min(1).max(4_000),
    requiredBehaviors: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    forbiddenBehaviors: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
  })
  .strict();

export const SkillSourceSnapshotSchema = z
  .object({
    ref: SkillSourceRevisionRefSchema,
    rootRef: MemorySubjectRefSchema,
    conversationRef: MemorySubjectRefSchema.optional(),
    sourceExecutionIds: z.array(z.string().min(1)).max(1_000).default([]),
    producerRefs: z.array(MemorySubjectRefSchema).max(100),
    title: z.string().trim().min(1).max(500),
    body: z.string().trim().min(1).max(24_000),
    outcome: z.enum(["succeeded", "failed", "cancelled", "interrupted", "supporting"]),
    hasSuccessfulRecovery: z.boolean(),
    observedAt: z.string().datetime(),
    verified: z.boolean(),
    valueScore: z.number().min(0).max(1).optional(),
    visibility: MemoryVisibilityPolicySchema,
    sensitivity: MemorySensitivitySchema,
  })
  .strict();

export const ExistingMemorySkillTargetSchema = z
  .object({
    bindingId: z.string().uuid(),
    capabilityId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    normalizedKeys: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
  })
  .strict();

export const SkillPackageFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(2_000)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          path
            .split("/")
            .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
        "Skill package paths must be safe relative paths.",
      ),
    content: z.string().max(128 * 1_024),
  })
  .strict();

export const SkillPackageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    files: z.array(SkillPackageFileSchema).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set(value.files.map((file) => file.path));
    if (paths.size !== value.files.length) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Skill file paths must be unique.",
      });
    }
    if (!paths.has("SKILL.md")) {
      context.addIssue({ code: "custom", path: ["files"], message: "SKILL.md is required." });
    }
    for (const file of value.files) {
      if (
        file.path !== "SKILL.md" &&
        !file.path.startsWith("references/") &&
        !file.path.startsWith("scripts/") &&
        !file.path.startsWith("tests/")
      ) {
        context.addIssue({
          code: "custom",
          path: ["files", value.files.indexOf(file), "path"],
          message:
            "Generated Skill files must be SKILL.md or live under references/, scripts/, or tests/.",
        });
      }
      if (
        (file.path.startsWith("scripts/") || file.path.startsWith("tests/")) &&
        !file.path.endsWith(".mjs")
      ) {
        context.addIssue({
          code: "custom",
          path: ["files", value.files.indexOf(file), "path"],
          message: "Generated executable files must be Node ESM .mjs files.",
        });
      }
    }
  });

export const SkillExtractionInputSchema = z
  .object({
    schemaVersion: z.literal(SKILL_EXTRACTION_INPUT_SCHEMA_VERSION),
    jobId: z.string().min(1),
    rootRef: MemorySubjectRefSchema,
    sources: z.array(SkillSourceSnapshotSchema).min(1).max(100),
    existingTargets: z.array(ExistingMemorySkillTargetSchema).max(100),
  })
  .strict();

const SkillCandidateContentSchema = z
  .object({
    normalizedKey: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .regex(/^[a-z0-9][a-z0-9._:/-]*$/u),
    applicability: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    failureModes: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    recoverySteps: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    package: SkillPackageSchema,
    replayCases: z.array(SkillReplayExpectationSchema).min(3).max(10),
    boundaryCase: SkillReplayExpectationSchema,
  })
  .strict();

export const SkillExtractionCandidateSchema = z
  .object({
    content: SkillCandidateContentSchema,
    sourceRefs: z.array(SkillSourceRevisionRefSchema).min(3).max(100),
    route: z.discriminatedUnion("type", [
      z.object({ type: z.literal("create") }).strict(),
      z.object({ type: z.literal("revise"), bindingId: z.string().uuid() }).strict(),
      z
        .object({
          type: z.literal("ambiguous"),
          bindingIds: z.array(z.string().uuid()).min(2).max(20),
        })
        .strict(),
    ]),
  })
  .strict();

export const SkillExtractionOutputSchema = z.discriminatedUnion("retain", [
  z
    .object({
      retain: z.literal(true),
      candidates: z.array(SkillExtractionCandidateSchema).min(1).max(3),
    })
    .strict(),
  z
    .object({
      retain: z.literal(false),
      reason: z.enum([
        "no-reusable-skill",
        "insufficient-independent-sources",
        "fragmentary-pattern",
        "sensitive",
      ]),
    })
    .strict(),
]);

export const SkillExtractorProvenanceSchema = z
  .object({
    curatorRef: z.string().min(1),
    promptVersion: z.string().min(1),
    profileRevision: z.number().int().nonnegative(),
    runtimeId: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    responseModel: z.string().min(1).optional(),
    extractedAt: z.string().datetime(),
  })
  .strict();

export const SkillLearningJobSchema = z
  .object({
    schemaVersion: z.literal(SKILL_LEARNING_JOB_SCHEMA_VERSION),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    rootRef: MemorySubjectRefSchema,
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    status: z.enum(["pending", "running", "needs_attention", "completed"]),
    attempts: z.number().int().nonnegative(),
    retryAt: z.string().datetime().optional(),
    leaseUntil: z.string().datetime().optional(),
    lastErrorCode: z.string().min(1).optional(),
    lastErrorMessage: z.string().min(1).max(4_096).optional(),
    lastFailure: MemoryExtractionFailureDiagnosticSchema.optional(),
    failureClass: z.enum(["configuration", "transient-exhausted", "capacity"]).optional(),
    completion: z.enum(["retained", "rejected"]).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type SkillSourceRevisionRef = z.infer<typeof SkillSourceRevisionRefSchema>;
export type SkillSourceSnapshot = z.infer<typeof SkillSourceSnapshotSchema>;
export type ExistingMemorySkillTarget = z.infer<typeof ExistingMemorySkillTargetSchema>;
export type SkillPackage = z.infer<typeof SkillPackageSchema>;
export type SkillExtractionInput = z.infer<typeof SkillExtractionInputSchema>;
export type SkillExtractionCandidate = z.infer<typeof SkillExtractionCandidateSchema>;
export type SkillExtractionOutput = z.infer<typeof SkillExtractionOutputSchema>;
export type SkillExtractorProvenance = z.infer<typeof SkillExtractorProvenanceSchema>;
export type SkillLearningJob = z.infer<typeof SkillLearningJobSchema>;
