import { z } from "zod";

export const PragmaV3ResourceKindSchema = z.enum([
  "Expert",
  "ExpertTeam",
  "Flow",
  "Automation",
  "Capability",
  "ContextStore",
  "RuntimeProfile",
  "Evaluation",
]);

/**
 * Historical envelope for resources written by pragma/v3. The v3-to-v4 step validates the
 * converted value with the authoritative current resource Schema after adding the new metadata.
 */
export const PragmaV3SemanticResourceSchema = z
  .object({
    apiVersion: z.literal("pragma/v3"),
    kind: PragmaV3ResourceKindSchema,
    metadata: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string(),
        tags: z.array(z.string()),
      })
      .strict(),
    spec: z.unknown(),
  })
  .strict();

export const PragmaV3BundleSchema = z
  .object({
    apiVersion: z.literal("pragma/v3"),
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaV3SemanticResourceSchema).default([]),
  })
  .strict();

export const PragmaV3LockSchema = z
  .object({
    apiVersion: z.literal("pragma/v3"),
    kind: z.literal("Lock"),
    compilerVersion: z.string().min(1),
    projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    resources: z.array(
      z
        .object({
          ref: z.string().trim().min(1),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
          source: z.string().min(1),
        })
        .strict(),
    ),
    artifacts: z
      .array(
        z
          .object({
            source: z.string().min(1),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type PragmaV3SemanticResource = z.infer<typeof PragmaV3SemanticResourceSchema>;
