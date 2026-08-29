import { z } from "zod";

import {
  ContextStoreChangeSetSchema,
  ContextStoreRevisionRequestSchema,
} from "@pragma/built-in-agents/contracts";

export const ContextStoreRevisionJobV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-job/v1"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    request: ContextStoreRevisionRequestSchema,
    state: z.enum([
      "pending",
      "running",
      "pending_review",
      "applying",
      "completed",
      "rejected",
      "needs_attention",
      "superseded",
    ]),
    changeSet: ContextStoreChangeSetSchema.optional(),
    supersededBy: z.string().uuid().optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ContextStoreRevisionJobV1 = z.infer<typeof ContextStoreRevisionJobV1Schema>;
