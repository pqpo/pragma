import { z } from "zod";

import { HistoricalMissionBaseSchema } from "./shared.ts";

export const MissionV5Schema = HistoricalMissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v5"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
});
