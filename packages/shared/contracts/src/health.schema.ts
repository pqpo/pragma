import { z } from "zod";

export const HealthResponseSchema = z.object({
  service: z.string(),
  status: z.literal("ok")
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
