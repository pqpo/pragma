import { z } from "zod";

export const SkillRevisionDraftV4StoredSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-draft/v4"),
    operation: z.enum(["revise", "create"]),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    capabilityId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    resourceDescription: z.string().trim().min(1).max(500).optional(),
    baseRevision: z.number().int().nonnegative(),
    baseContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workspacePath: z.string().trim().min(1).max(4_000),
    state: z.enum([
      "editing",
      "pending_review",
      "publishing",
      "completed",
      "rejected",
      "needs_attention",
    ]),
    activeMissionId: z.string().uuid().optional(),
    submissionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    submittedRevision: z.number().int().positive().optional(),
    summary: z.string().trim().min(1).max(2_000).optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type SkillRevisionDraftV4Stored = z.infer<typeof SkillRevisionDraftV4StoredSchema>;
