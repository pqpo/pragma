import { z } from "zod";

import { PragmaForwardCompatibleResourceSchema as PragmaCompilerV9ResourceSchema } from "../../migrations/schemas/v5.ts";

export { PragmaCompilerV9ResourceSchema };

export const PragmaCompilerV9BundleSchema = z
  .object({
    apiVersion: z.literal("pragma/v5"),
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaCompilerV9ResourceSchema).default([]),
  })
  .strict();

export const PragmaCompilerV9LockSchema = z
  .object({
    apiVersion: z.literal("pragma/v5"),
    kind: z.literal("Lock"),
    compilerVersion: z.literal("pragma.dsl/v9"),
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

export type PragmaCompilerV9Resource = z.infer<typeof PragmaCompilerV9ResourceSchema>;
