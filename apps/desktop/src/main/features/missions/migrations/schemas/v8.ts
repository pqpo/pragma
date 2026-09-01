import { z } from "zod";

import {
  HistoricalMissionBaseSchema,
  HistoricalMissionOriginSchema,
  refineHistoricalFlowMission,
} from "./shared.ts";

export const MissionContextStoreIdsV8Schema = z
  .array(z.string().uuid())
  .max(200)
  .superRefine((storeIds, context) => {
    const seen = new Set<string>();
    for (const [index, storeId] of storeIds.entries()) {
      if (seen.has(storeId)) {
        context.addIssue({
          code: "custom",
          message: "Mission Knowledge Stores must be unique.",
          path: [index],
        });
      }
      seen.add(storeId);
    }
  });

export const MissionV8Schema = HistoricalMissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v8"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
  origin: HistoricalMissionOriginSchema.default({ type: "user" }),
  contextStoreIds: MissionContextStoreIdsV8Schema,
}).superRefine(refineHistoricalFlowMission);
