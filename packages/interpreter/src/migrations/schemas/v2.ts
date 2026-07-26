import { z } from "zod";

export const PragmaV2ResourceKindSchema = z.enum([
  "Expert",
  "ExpertTeam",
  "Flow",
  "Automation",
  "Capability",
  "ContextStore",
  "RuntimeProfile",
]);

export const PragmaV2SemanticResourceSchema = z
  .object({
    apiVersion: z.literal("pragma/v2"),
    kind: PragmaV2ResourceKindSchema,
    metadata: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1),
        name: z.string().min(1),
      })
      .passthrough(),
    spec: z.unknown(),
  })
  .passthrough();

export type PragmaV2SemanticResource = z.infer<typeof PragmaV2SemanticResourceSchema>;
