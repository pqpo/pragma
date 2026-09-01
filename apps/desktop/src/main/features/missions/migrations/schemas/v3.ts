import { HistoricalMissionBaseV4Schema } from "./shared.ts";
import { z } from "zod";

export const MissionV3Schema = HistoricalMissionBaseV4Schema.extend({
  schemaVersion: z.literal("pragma.mission/v3"),
});
