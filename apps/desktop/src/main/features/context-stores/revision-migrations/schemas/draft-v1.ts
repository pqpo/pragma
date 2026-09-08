import { z } from "zod";

import { ContextStoreDraftOverlaySchema } from "@pragma/built-in-agents/contracts";

export const ContextStoreDraftV1Schema = z.object({
  schemaVersion: z.literal("pragma.context-store-draft/v1"),
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  storeId: z.string().uuid(),
  baseRevision: z.number().int().positive(),
  baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum([
    "editing",
    "pending_review",
    "merging",
    "needs_rebase",
    "needs_attention",
    "merged",
  ]),
  overlay: ContextStoreDraftOverlaySchema,
  activeMissionId: z.string().uuid().optional(),
  submittedRevision: z.number().int().positive().optional(),
  summary: z.string().trim().min(1).max(2_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
