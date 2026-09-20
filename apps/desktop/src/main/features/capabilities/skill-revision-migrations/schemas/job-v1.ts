import { SkillRevisionChangeSetSchema } from "@pragma/built-in-agents/contracts";
import { SkillSourceRevisionRefSchema } from "@pragma/shared";
import { z } from "zod";

const ReplayCaseSchema = z
  .object({
    objective: z.string().min(1).max(4_000),
    requiredBehaviors: z.array(z.string().min(1).max(2_000)).min(1).max(20),
    forbiddenBehaviors: z.array(z.string().min(1).max(2_000)).max(20),
  })
  .strict();

export const SkillRevisionRequestV1StoredSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-request/v1"),
    capabilityId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(50_000),
    source: z.enum(["user", "memory-learning"]),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    sourceRefs: z.array(SkillSourceRevisionRefSchema).max(100).default([]),
    replayCases: z.array(ReplayCaseSchema).min(3).max(10).optional(),
    boundaryCase: ReplayCaseSchema.optional(),
  })
  .strict();

export const SkillRevisionJobV1StoredSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-job/v1"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    request: SkillRevisionRequestV1StoredSchema,
    state: z.enum([
      "pending",
      "running",
      "evaluating",
      "pending_review",
      "applying",
      "completed",
      "rejected",
      "needs_attention",
      "superseded",
    ]),
    changeSet: SkillRevisionChangeSetSchema.optional(),
    evaluation: z.unknown().optional(),
    supersededBy: z.string().uuid().optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type SkillRevisionRequestV1Stored = z.infer<typeof SkillRevisionRequestV1StoredSchema>;
export type SkillRevisionJobV1Stored = z.infer<typeof SkillRevisionJobV1StoredSchema>;
