import { z } from "zod";

import { SkillSourceRevisionRefSchema } from "@pragma/shared";

export const KnowledgeLearningPlanSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip") }).strict(),
  z
    .object({
      action: z.literal("apply"),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

export const SkillLearningPlanSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip") }).strict(),
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
              sourceRefs: z.array(SkillSourceRevisionRefSchema).min(3).max(8),
              target: z.discriminatedUnion("type", [
                z.object({ type: z.literal("create") }).strict(),
                z
                  .object({
                    type: z.literal("revise"),
                    capabilityId: z.string().regex(/^(?:[0-9a-hjkmnp-tv-z]{16}|[0-9a-f-]{36})$/u),
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

export type KnowledgeLearningPlan = z.infer<typeof KnowledgeLearningPlanSchema>;
export type SkillLearningPlan = z.infer<typeof SkillLearningPlanSchema>;
