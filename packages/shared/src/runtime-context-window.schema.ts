import { z } from "zod";

export const RuntimeContextWindowMeasurementSchema = z.enum(["reported", "derived", "estimated"]);

export const RuntimeContextWindowUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative().nullable(),
  contextWindowTokens: z.number().int().positive(),
  percent: z.number().nonnegative().nullable(),
  measurement: RuntimeContextWindowMeasurementSchema,
  observedAt: z.string().datetime(),
});

export type RuntimeContextWindowMeasurement = z.infer<typeof RuntimeContextWindowMeasurementSchema>;
export type RuntimeContextWindowUsage = z.infer<typeof RuntimeContextWindowUsageSchema>;
