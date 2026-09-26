import { z } from "zod";
import { MemoryExtractionFailureDiagnosticSchema } from "./extraction-failure.schema.ts";
import { SemanticResourceIdSchema } from "../integration/primitives.schema.ts";

import {
  MemorySensitivitySchema,
  MemorySubjectRefSchema,
  MemoryVisibilityPolicySchema,
} from "./memory-plane.schema.ts";

export const SKILL_LEARNING_JOB_SCHEMA_VERSION = "pragma.memory-skill-job/v2" as const;
export const MAX_SKILL_PACKAGE_BYTES = 25 * 1_024 * 1_024;
export const MAX_GENERATED_SKILL_FILE_CHARACTERS = 128 * 1_024;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export const SkillSourceRevisionRefSchema = z
  .object({
    kind: z.enum(["episodic", "semantic", "knowledge"]),
    id: z.string().min(1),
    revision: z.number().int().positive(),
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
    capabilityId: z.union([SemanticResourceIdSchema, z.string().uuid()]),
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
            .every(
              (segment) =>
                segment.length > 0 &&
                segment !== "." &&
                segment !== ".." &&
                segment.toLowerCase() !== ".git",
            ),
        "Skill package paths must be safe relative paths.",
      ),
    content: z.string().max(MAX_SKILL_PACKAGE_BYTES),
  })
  .strict();

export const SkillPackageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    files: z.array(SkillPackageFileSchema).min(1).max(1_000),
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
    const totalBytes = value.files.reduce((sum, file) => sum + utf8ByteLength(file.content), 0);
    if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: `Skill packages may contain at most ${MAX_SKILL_PACKAGE_BYTES} bytes.`,
      });
    }
  });

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
export type SkillLearningJob = z.infer<typeof SkillLearningJobSchema>;
