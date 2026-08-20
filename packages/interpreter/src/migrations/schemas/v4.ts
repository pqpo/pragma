import { z } from "zod";

export const PragmaV4ResourceKindSchema = z.enum([
  "Expert",
  "ExpertTeam",
  "Flow",
  "Automation",
  "Capability",
  "ContextStore",
  "RuntimeProfile",
  "Evaluation",
]);

/** Historical envelope for semantic resources written by pragma/v4. */
export const PragmaV4SemanticResourceSchema = z
  .object({
    apiVersion: z.literal("pragma/v4"),
    kind: PragmaV4ResourceKindSchema,
    metadata: z
      .object({
        id: z.string().min(1),
        avatarId: z.string().min(1).optional(),
        name: z.string().min(1),
        description: z.string(),
        tags: z.array(z.string()),
      })
      .passthrough(),
    spec: z.unknown(),
  })
  .strict();
