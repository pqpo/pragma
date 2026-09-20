import { z } from "zod";

const SkillSourceRevisionRefV1Schema = z
  .object({
    kind: z.enum(["episodic", "semantic", "knowledge"]),
    id: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

const SkillPackageFileV1Schema = z
  .object({
    path: z.string().min(1).max(2_000),
    content: z.string().max(128 * 1_024),
  })
  .strict();

const SkillPackageV1Schema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    files: z.array(SkillPackageFileV1Schema).min(1).max(64),
  })
  .strict();

const TargetOptionSchema = z
  .object({
    bindingId: z.string().uuid(),
    capabilityId: z.string().uuid(),
    name: z.string().min(1).max(120),
    description: z.string().max(500),
  })
  .strict();

export const MemorySkillCandidateV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.memory-skill-candidate/v1"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    expertRef: z.string().regex(/^expert:[0-9a-hjkmnp-tv-z]{16}$/u),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    normalizedKey: z.string().min(1).max(300),
    sourceRefs: z.array(SkillSourceRevisionRefV1Schema).min(3).max(100),
    package: SkillPackageV1Schema,
    replayCases: z.array(z.unknown()).min(3).max(10),
    boundaryCase: z.unknown(),
    route: z.discriminatedUnion("type", [
      z.object({ type: z.literal("create") }).strict(),
      z
        .object({
          type: z.literal("needs_target"),
          options: z.array(TargetOptionSchema).min(2).max(20),
        })
        .strict(),
    ]),
    state: z.enum([
      "needs_target",
      "evaluating",
      "pending_review",
      "needs_attention",
      "rejected",
      "approved",
      "promoted",
    ]),
    evaluation: z.unknown().optional(),
    capabilityId: z.string().uuid().optional(),
    lastErrorCode: z.string().min(1).max(100).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type MemorySkillCandidateV1 = z.infer<typeof MemorySkillCandidateV1Schema>;
