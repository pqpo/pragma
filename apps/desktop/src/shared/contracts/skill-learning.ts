import { SkillPackageFileSchema, SkillPackageSchema, SkillSourceRevisionRefSchema } from "@pragma/shared";
import { z } from "zod";

import { CapabilityIdSchema, ExpertModelConfigSchema } from "./capabilities.ts";

export const MemorySkillTargetOptionSchema = z
  .object({
    bindingId: z.string().uuid(),
    capabilityId: CapabilityIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(500),
  })
  .strict();

export const SkillEvaluationSnapshotSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-evaluation-snapshot/v1"),
    subjectHash: z.string().regex(/^[a-f0-9]{64}$/u),
    passed: z.boolean(),
    staticChecksPassed: z.boolean(),
    scriptTestsPassed: z.boolean(),
    profileRevision: z.number().int().nonnegative(),
    runtimeId: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: z.enum(["source-replay", "boundary"]),
            passed: z.boolean(),
            assertions: z.array(
              z
                .object({
                  dimension: z.enum([
                    "applicability",
                    "correctness",
                    "completeness",
                    "recovery",
                    "safety",
                  ]),
                  passed: z.boolean(),
                  message: z.string().min(1).max(2_000),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(4)
      .max(20),
    evaluatedAt: z.string().datetime(),
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
    replayCases: z.array(z.object({
      objective: z.string().min(1).max(4_000),
      requiredBehaviors: z.array(z.string().min(1).max(2_000)).min(1).max(20),
      forbiddenBehaviors: z.array(z.string().min(1).max(2_000)).max(20),
    }).strict()).min(3).max(10),
    boundaryCase: z.object({
      objective: z.string().min(1).max(4_000),
      requiredBehaviors: z.array(z.string().min(1).max(2_000)).min(1).max(20),
      forbiddenBehaviors: z.array(z.string().min(1).max(2_000)).max(20),
    }).strict(),
    route: z.discriminatedUnion("type", [
      z.object({ type: z.literal("create") }).strict(),
      z
        .object({
          type: z.literal("needs_target"),
          options: z.array(MemorySkillTargetOptionSchema).min(2).max(20),
        })
        .strict(),
    ]),
    state: z.enum(["needs_target", "evaluating", "pending_review", "needs_attention", "rejected", "approved", "promoted"]),
    evaluation: SkillEvaluationSnapshotSchema.optional(),
    capabilityId: CapabilityIdSchema.optional(),
    lastErrorCode: z.string().min(1).max(100).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.state === "pending_review" && candidate.evaluation?.passed !== true) {
      context.addIssue({ code: "custom", path: ["evaluation"], message: "Reviewable candidates require a passing evaluation." });
    }
    if (candidate.state === "promoted" && candidate.capabilityId === undefined) {
      context.addIssue({ code: "custom", path: ["capabilityId"], message: "Promoted candidates require a Capability id." });
    }
  });

export const MemorySkillCandidateRefSchema = z.object({ id: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
export const ListMemorySkillCandidatesSchema = z.object({ state: MemorySkillCandidateSchema.shape.state.optional() }).strict();
export const UpdateMemorySkillCandidateSchema = MemorySkillCandidateRefSchema.extend({ package: SkillPackageSchema }).strict();
export const ResolveMemorySkillTargetSchema = MemorySkillCandidateRefSchema.extend({
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("create") }).strict(),
    z.object({ type: z.literal("revise"), bindingId: z.string().uuid() }).strict(),
  ]),
}).strict();

export const SkillFileChangeOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("upsert"), path: SkillPackageFileSchema.shape.path, content: SkillPackageFileSchema.shape.content, previousContent: z.string().optional() }).strict(),
  z.object({ operation: z.literal("rename"), path: SkillPackageFileSchema.shape.path, nextPath: SkillPackageFileSchema.shape.path }).strict(),
  z.object({ operation: z.literal("delete"), path: SkillPackageFileSchema.shape.path, previousContent: z.string().optional() }).strict(),
]);

export const SkillRevisionChangeSetSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-change-set/v1"),
    capabilityId: CapabilityIdSchema,
    baseRevision: z.number().int().positive(),
    baseContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(2_000),
    operations: z.array(SkillFileChangeOperationSchema).min(1).max(100),
  })
  .strict();

export const SkillRevisionRequestSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-request/v1"),
    capabilityId: CapabilityIdSchema,
    prompt: z.string().trim().min(1).max(50_000),
    source: z.enum(["user", "memory-learning"]),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    sourceRefs: z.array(SkillSourceRevisionRefSchema).max(100).default([]),
    replayCases: MemorySkillCandidateSchema.shape.replayCases.optional(),
    boundaryCase: MemorySkillCandidateSchema.shape.boundaryCase.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.source === "memory-learning" && (request.sourceDigest === undefined || request.replayCases === undefined || request.boundaryCase === undefined)) {
      context.addIssue({ code: "custom", message: "Memory Skill revisions require a digest and replay cases." });
    }
  });

export const SkillRevisionJobStateSchema = z.enum(["pending", "running", "evaluating", "pending_review", "applying", "completed", "rejected", "needs_attention", "superseded"]);
export const SkillRevisionJobSchema = z.object({
  schemaVersion: z.literal("pragma.skill-revision-job/v1"), id: z.string().uuid(), revision: z.number().int().positive(),
  request: SkillRevisionRequestSchema, state: SkillRevisionJobStateSchema,
  changeSet: SkillRevisionChangeSetSchema.optional(), evaluation: SkillEvaluationSnapshotSchema.optional(),
  supersededBy: z.string().uuid().optional(), error: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) }).strict().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const SkillRevisionJobRefSchema = z.object({ jobId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
export const ListSkillRevisionJobsSchema = z.object({ capabilityId: CapabilityIdSchema.optional(), state: SkillRevisionJobStateSchema.optional() }).strict();

export const SkillEvaluationProfileSchema = z.object({
  schemaVersion: z.literal("pragma.skill-evaluation-profile/v1"), revision: z.number().int().nonnegative(),
  mode: z.enum(["inherit-default", "pinned"]), model: ExpertModelConfigSchema.optional(), updatedAt: z.string().datetime(),
}).strict().superRefine((profile, context) => {
  if ((profile.mode === "pinned") !== (profile.model !== undefined)) context.addIssue({ code: "custom", path: ["model"], message: "Pinned Evaluation profiles require a model and inherited profiles cannot pin one." });
});
export const UpdateSkillEvaluationProfileSchema = z.object({ expectedRevision: z.number().int().nonnegative(), mode: z.enum(["inherit-default", "pinned"]), model: ExpertModelConfigSchema.optional() }).strict();

export type MemorySkillCandidate = z.infer<typeof MemorySkillCandidateSchema>;
export type MemorySkillCandidateRef = z.infer<typeof MemorySkillCandidateRefSchema>;
export type UpdateMemorySkillCandidate = z.infer<typeof UpdateMemorySkillCandidateSchema>;
export type ResolveMemorySkillTarget = z.infer<typeof ResolveMemorySkillTargetSchema>;
export type SkillRevisionChangeSet = z.infer<typeof SkillRevisionChangeSetSchema>;
export type SkillRevisionRequest = z.infer<typeof SkillRevisionRequestSchema>;
export type SkillRevisionJob = z.infer<typeof SkillRevisionJobSchema>;
export type ListSkillRevisionJobs = z.infer<typeof ListSkillRevisionJobsSchema>;
export type SkillEvaluationSnapshot = z.infer<typeof SkillEvaluationSnapshotSchema>;
export type SkillEvaluationProfile = z.infer<typeof SkillEvaluationProfileSchema>;
export type UpdateSkillEvaluationProfile = z.infer<typeof UpdateSkillEvaluationProfileSchema>;
