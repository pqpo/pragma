import { SkillPackageSchema, SkillSourceRevisionRefSchema } from "@pragma/shared";
import { z } from "zod";

import { CapabilityIdSchema } from "./capabilities.ts";

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
    schemaVersion: z.literal("pragma.memory-skill-candidate/v2"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    expertRef: z.string().regex(/^expert:[0-9a-hjkmnp-tv-z]{16}$/u),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    normalizedKey: z.string().min(1).max(300),
    sourceRefs: z.array(SkillSourceRevisionRefSchema).min(3).max(100),
    package: SkillPackageSchema,
    route: z.discriminatedUnion("type", [
      z.object({ type: z.literal("create") }).strict(),
      z.object({ type: z.literal("revise"), bindingId: z.string().uuid() }).strict(),
      z
        .object({
          type: z.literal("needs_target"),
          options: z.array(MemorySkillTargetOptionSchema).min(2).max(20),
        })
        .strict(),
    ]),
    state: z.enum([
      "needs_target",
      "pending_review",
      "revision_pending",
      "needs_attention",
      "rejected",
      "approved",
      "promoted",
    ]),
    capabilityId: CapabilityIdSchema.optional(),
    revisionJobId: z.string().uuid().optional(),
    lastErrorCode: z.string().min(1).max(100).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.state === "promoted" && candidate.capabilityId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["capabilityId"],
        message: "Promoted candidates require a Capability id.",
      });
    }
    if (
      candidate.state === "revision_pending" &&
      (candidate.capabilityId === undefined || candidate.revisionJobId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revisionJobId"],
        message: "Pending Memory revisions require Capability and revision job ids.",
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
