import { z } from "zod";

import {
  HistoricalMissionBaseSchema,
  HistoricalMissionOriginSchema,
  refineHistoricalFlowMission,
} from "./shared.ts";

export const MissionV7Schema = HistoricalMissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v7"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
  origin: HistoricalMissionOriginSchema.default({ type: "user" }),
}).superRefine(refineHistoricalFlowMission);
