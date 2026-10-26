/** Legacy pre-#434 plan handoff only. New learning work uses MemoryRevisionExecutor. */
import { z } from "zod";
import {
  KnowledgeSourceRevisionRefSchema,
  SkillSourceRevisionRefSchema,
  SkillPackageFileSchema,
} from "@pragma/shared";

export const MEMORY_LEARNING_POLICY_VERSION = "learning-v2";

const reason = z.string().trim().min(1).max(2000);
const skip = z
  .object({
    action: z.literal("skip"),
    reason: reason.optional(),
    disposition: z.enum(["accumulate", "duplicate", "unsupported"]).optional(),
    waitForTarget: z.string().min(1).max(300).optional(),
  })
  .strict();

export const KnowledgeLearningPlanSchema = z.discriminatedUnion("action", [
  skip,
  z
    .object({
      action: z.literal("apply"),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(2000),
      rationale: reason,
      sourceRefs: z.array(KnowledgeSourceRevisionRefSchema).min(1).max(20),
      maturity: z.enum(["incremental", "cross-conversation", "validated-artifact"]),
      target: z.discriminatedUnion("type", [
        z.object({ type: z.literal("create"), justification: reason }).strict(),
        z
          .object({
            type: z.literal("revise"),
            storeId: z.string().uuid(),
            baseRevision: z.number().int().positive(),
            snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      ]),
    })
    .strict(),
]);

export const SkillLearningPlanSchema = z.discriminatedUnion("action", [
  skip,
  z
    .object({
      action: z.literal("apply"),
      changes: z
        .array(
          z
            .object({
              name: z.string().trim().min(1).max(120),
              description: z.string().trim().min(1).max(500),
              normalizedKey: z
                .string()
                .trim()
                .min(1)
                .max(300)
                .regex(/^[a-z0-9][a-z0-9._:/-]*$/u),
              targetFiles: z.array(SkillPackageFileSchema.shape.path).min(1).max(20).optional(),
              sourceRefs: z.array(SkillSourceRevisionRefSchema).min(1).max(8),
              target: z.discriminatedUnion("type", [
                z.object({ type: z.literal("create") }).strict(),
                z
                  .object({
                    type: z.literal("revise"),
                    capabilityId: z.string().regex(/^(?:[0-9a-hjkmnp-tv-z]{16}|[0-9a-f-]{36})$/u),
                    baseRevision: z.number().int().positive().optional(),
                    contentHash: z
                      .string()
                      .regex(/^[a-f0-9]{64}$/u)
                      .optional(),
                  })
                  .strict(),
              ]),
            })
            .strict(),
        )
        .min(1)
        .max(3),
    })
    .strict(),
]);

export interface ExistingKnowledgeLearningTarget {
  readonly storeId: string;
  readonly name: string;
  readonly description: string;
  readonly baseRevision: number;
  readonly snapshotHash: string;
  readonly mounted: boolean;
  readonly pending?: boolean;
  readonly body?: string;
}

export type KnowledgeLearningPlan = z.infer<typeof KnowledgeLearningPlanSchema>;
export type SkillLearningPlan = z.infer<typeof SkillLearningPlanSchema>;
