import { z } from "zod";

export const SkillRevisionJobV4StoredSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-job/v4"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    draftId: z.string().uuid(),
    missionId: z.string().uuid().optional(),
    request: z
      .object({
        schemaVersion: z.literal("pragma.skill-revision-request/v4"),
        operation: z.enum(["revise", "create"]),
        capabilityId: z.string().uuid(),
        resourceName: z.string().trim().min(1).max(120).optional(),
        resourceDescription: z.string().trim().min(1).max(500).optional(),
        prompt: z.string().trim().min(1).max(50_000),
        source: z.enum(["user", "expert-reflection", "memory-learning"]),
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        provenance: z
          .object({
            executionId: z.string().uuid(),
            invocationId: z.string().uuid(),
            expertId: z.string().min(1).max(200),
            teamId: z.string().min(1).max(200).optional(),
          })
          .strict()
          .optional(),
        sourceRefs: z.array(z.unknown()).max(100).default([]),
      })
      .strict(),
    state: z.enum([
      "editing",
      "running",
      "pending_review",
      "publishing",
      "completed",
      "rejected",
      "needs_attention",
      "superseded",
    ]),
    publishedRevision: z.number().int().positive().optional(),
    supersededBy: z.string().uuid().optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type SkillRevisionJobV4Stored = z.infer<typeof SkillRevisionJobV4StoredSchema>;
