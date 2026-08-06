import { SkillEvaluationSnapshotSchema } from "@pragma/built-in-agents/contracts";
import { SkillPackageSchema, SkillSourceRevisionRefSchema } from "@pragma/shared";
import { z } from "zod";

import { CapabilityIdSchema } from "./capabilities.ts";

export {
  ListSkillRevisionJobsSchema,
  SkillEvaluationProfileSchema,
  SkillEvaluationSnapshotSchema,
  SkillFileChangeOperationSchema,
  SkillRevisionChangeSetSchema,
  SkillRevisionJobRefSchema,
  SkillRevisionJobSchema,
  SkillRevisionJobStateSchema,
  SkillRevisionRequestSchema,
  UpdateSkillEvaluationProfileSchema,
} from "@pragma/built-in-agents/contracts";

export type {
  ListSkillRevisionJobs,
  SkillEvaluationProfile,
  SkillEvaluationSnapshot,
  SkillRevisionChangeSet,
  SkillRevisionJob,
  SkillRevisionRequest,
  UpdateSkillEvaluationProfile,
} from "@pragma/built-in-agents/contracts";

export const MemorySkillTargetOptionSchema = z
  .object({
    bindingId: z.string().uuid(),
    capabilityId: CapabilityIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(500),
  })
  .strict();

export const MemorySkillCandidateSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-skill-candidate/v1"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    expertRef: z.string().regex(/^expert:[0-9a-hjkmnp-tv-z]{16}$/u),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    normalizedKey: z.string().min(1).max(300),
    sourceRefs: z.array(SkillSourceRevisionRefSchema).min(3).max(100),
    package: SkillPackageSchema,
    replayCases: z
      .array(
        z
          .object({
            objective: z.string().min(1).max(4_000),
            requiredBehaviors: z.array(z.string().min(1).max(2_000)).min(1).max(20),
            forbiddenBehaviors: z.array(z.string().min(1).max(2_000)).max(20),
          })
          .strict(),
      )
      .min(3)
      .max(10),
    boundaryCase: z
      .object({
        objective: z.string().min(1).max(4_000),
        requiredBehaviors: z.array(z.string().min(1).max(2_000)).min(1).max(20),
        forbiddenBehaviors: z.array(z.string().min(1).max(2_000)).max(20),
      })
      .strict(),
    route: z.discriminatedUnion("type", [
      z.object({ type: z.literal("create") }).strict(),
      z
        .object({
          type: z.literal("needs_target"),
          options: z.array(MemorySkillTargetOptionSchema).min(2).max(20),
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
    evaluation: SkillEvaluationSnapshotSchema.optional(),
    capabilityId: CapabilityIdSchema.optional(),
    lastErrorCode: z.string().min(1).max(100).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.state === "pending_review" && candidate.evaluation?.passed !== true) {
      context.addIssue({
        code: "custom",
        path: ["evaluation"],
        message: "Reviewable candidates require a passing evaluation.",
      });
    }
    if (candidate.state === "promoted" && candidate.capabilityId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["capabilityId"],
        message: "Promoted candidates require a Capability id.",
      });
    }
  });

export const MemorySkillCandidateRefSchema = z
  .object({ id: z.string().uuid(), expectedRevision: z.number().int().positive() })
  .strict();
export const ListMemorySkillCandidatesSchema = z
  .object({ state: MemorySkillCandidateSchema.shape.state.optional() })
  .strict();
export const UpdateMemorySkillCandidateSchema = MemorySkillCandidateRefSchema.extend({
  package: SkillPackageSchema,
}).strict();
export const ResolveMemorySkillTargetSchema = MemorySkillCandidateRefSchema.extend({
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("create") }).strict(),
    z.object({ type: z.literal("revise"), bindingId: z.string().uuid() }).strict(),
  ]),
}).strict();

export type MemorySkillCandidate = z.infer<typeof MemorySkillCandidateSchema>;
export type MemorySkillCandidateRef = z.infer<typeof MemorySkillCandidateRefSchema>;
export type UpdateMemorySkillCandidate = z.infer<typeof UpdateMemorySkillCandidateSchema>;
export type ResolveMemorySkillTarget = z.infer<typeof ResolveMemorySkillTargetSchema>;
