import { z } from "zod";
export const SharedConfigurationChangeSchema = z
  .object({
    scope: z.literal("shared"),
    expectedImpact: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const ModelProviderImpactSchema = z
  .object({
    scope: z.literal("shared"),
    providerId: z.string().uuid(),
    providerRevision: z.number().int().nonnegative(),
    projectRevision: z.number().int().nonnegative(),
    complete: z.boolean(),
    affectedResourceRefs: z.array(z.string().min(1)),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SharedConfigurationChange = z.infer<typeof SharedConfigurationChangeSchema>;
export type ModelProviderImpact = z.infer<typeof ModelProviderImpactSchema>;
