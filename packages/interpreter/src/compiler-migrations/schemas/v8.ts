import { z } from "zod";

import { PragmaForwardCompatibleResourceSchema as PragmaCompilerV8ResourceSchema } from "./v8-resource.ts";

export { PragmaCompilerV8ResourceSchema };

export const PragmaCompilerV8BundleSchema = z
  .object({
    apiVersion: z.literal("pragma/v5"),
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaCompilerV8ResourceSchema).default([]),
  })
  .strict();

export const PragmaCompilerV8LockSchema = z
  .object({
    apiVersion: z.literal("pragma/v5"),
    kind: z.literal("Lock"),
    compilerVersion: z.literal("pragma.dsl/v8"),
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

export type PragmaCompilerV8Resource = z.infer<typeof PragmaCompilerV8ResourceSchema>;
