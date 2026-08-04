import { MemorySubjectRefSchema } from "@pragma/shared";
import { z } from "zod";

import { SemanticExtractionJobV2Schema } from "./v2.ts";

export const SemanticExtractionJobV3Schema = SemanticExtractionJobV2Schema.omit({
  schemaVersion: true,
  status: true,
})
  .extend({
    schemaVersion: z.literal("pragma.memory-semantic-job/v3"),
    conversationRef: MemorySubjectRefSchema,
    sourceExecutionIds: z.array(z.string().min(1)).min(1).max(1_000),
    sourceUpdatedAt: z.string().datetime(),
    inputWatermark: z.string().min(1),
    eligibleAt: z.string().datetime().optional(),
    status: z.enum([
      "waiting_idle",
      "pending",
      "running",
      "needs_attention",
      "completed",
      "expired",
    ]),
  })
  .strict();
