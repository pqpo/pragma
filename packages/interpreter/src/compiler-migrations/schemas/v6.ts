import { z } from "zod";

import { PragmaV4SemanticResourceSchema } from "../../migrations/schemas/v4.ts";

export const PragmaCompilerV6ResourceSchema = PragmaV4SemanticResourceSchema;

export const PragmaCompilerV6BundleSchema = z
  .object({
    apiVersion: z.literal("pragma/v4"),
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaCompilerV6ResourceSchema).default([]),
  })
  .strict();

export const PragmaCompilerV6LockSchema = z
  .object({
    apiVersion: z.literal("pragma/v4"),
    kind: z.literal("Lock"),
    compilerVersion: z.literal("pragma.dsl/v6"),
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

export type PragmaCompilerV6Resource = z.infer<typeof PragmaCompilerV6ResourceSchema>;
