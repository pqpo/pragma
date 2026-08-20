import { z } from "zod";

import { PragmaV4SemanticResourceSchema } from "../../migrations/schemas/v4.ts";

export const PragmaCompilerV7ResourceSchema = PragmaV4SemanticResourceSchema;

export const PragmaCompilerV7BundleSchema = z
  .object({
    apiVersion: z.literal("pragma/v4"),
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaCompilerV7ResourceSchema).default([]),
  })
  .strict();

export const PragmaCompilerV7LockSchema = z
  .object({
    apiVersion: z.literal("pragma/v4"),
    kind: z.literal("Lock"),
    compilerVersion: z.literal("pragma.dsl/v7"),
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

export type PragmaCompilerV7Resource = z.infer<typeof PragmaCompilerV7ResourceSchema>;
