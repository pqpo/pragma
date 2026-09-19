import { z } from "zod";

import { ContextStoreRevisionRequestV1Schema } from "./v1.ts";

export const ContextStoreRevisionJobV2Schema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-job/v2"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    draftId: z.string().uuid(),
    missionId: z.string().uuid().optional(),
    request: ContextStoreRevisionRequestV1Schema,
    state: z.enum([
      "editing",
      "running",
      "pending_review",
      "merging",
      "merged",
      "rejected",
      "needs_rebase",
      "needs_attention",
    ]),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ContextStoreRevisionJobV2 = z.infer<typeof ContextStoreRevisionJobV2Schema>;
