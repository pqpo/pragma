import { z } from "zod";

import { HistoricalMissionBaseV4Schema } from "./shared.ts";

export const MissionV4Schema = HistoricalMissionBaseV4Schema.extend({
  schemaVersion: z.literal("pragma.mission/v4"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
});
