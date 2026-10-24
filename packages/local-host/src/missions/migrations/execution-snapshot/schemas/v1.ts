import { z } from "zod";
import { RuntimeModelSelectionSchema } from "@pragma/shared";

export const HistoricalSnapshotSchema = z.object({
  schemaVersion: z.literal("pragma.mission-execution-snapshot/v1"),
  missionId: z.string().min(1),
  project: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
  executorRef: z.string().min(1),
  resources: z.array(z.unknown()),
  fingerprints: z.array(z.tuple([z.string(), z.string()])),
  capabilities: z.array(
    z.object({
      capabilityId: z.string().min(1),
      resolvedRevision: z.number().int().positive(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  pluginRefs: z.array(z.string().min(1)),
  sources: z.record(
    z.string(),
    z.object({
      expertResource: z.unknown().optional(),
      additionalResources: z.array(z.unknown()),
      rootExecutionOverride: z
        .object({
          runtimeId: z.string().min(1),
          modelSelection: RuntimeModelSelectionSchema.optional(),
        })
        .optional(),
      rootModelSelectionOverride: RuntimeModelSelectionSchema.optional(),
      defaultModelSelection: RuntimeModelSelectionSchema.optional(),
    }),
  ),
});
