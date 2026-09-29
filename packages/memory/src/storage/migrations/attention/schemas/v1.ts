import { z } from "zod";
export const MemoryAttentionEntryV1Schema = z
  .object({
    module: z.enum(["episodic", "semantic"]),
    memoryId: z.string().min(1),
    revision: z.number().int().positive(),
    relevance: z.number().min(0).max(1),
    reason: z.enum(["new_error", "new_observation", "goal_changed", "historical_precedent"]),
    firstActivatedAt: z.string().datetime(),
    lastRelevantAt: z.string().datetime(),
  })
  .strict();
export const MemoryAttentionStateV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.memory-attention/v1"),
    missionId: z.string().min(1),
    contextId: z.string().min(1),
    scopeDigest: z.string().min(1),
    generation: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    active: z.array(MemoryAttentionEntryV1Schema).max(8),
    lastDeltaDigest: z.string().optional(),
    lastHintedVersion: z.number().int().nonnegative().default(0),
    lastReadVersion: z.number().int().nonnegative().default(0),
    audit: z
      .array(
        z
          .object({
            occurredAt: z.string().datetime(),
            deltaDigest: z.string(),
            result: z.enum(["updated", "unchanged", "skipped", "failed"]),
            code: z.string().optional(),
            refs: z.array(z.string()).max(16),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type MemoryAttentionEntryV1 = z.infer<typeof MemoryAttentionEntryV1Schema>;
export type MemoryAttentionStateV1 = z.infer<typeof MemoryAttentionStateV1Schema>;
