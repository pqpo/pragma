import { z } from "zod";

/** Existing lease metadata, shared by its writer and targeted Runtime recovery. */
export const ExpertSessionLeaseSchema = z.object({
  claimId: z.string().min(1),
  processId: z.number().int().positive().optional(),
  expiresAt: z.string().datetime(),
});
