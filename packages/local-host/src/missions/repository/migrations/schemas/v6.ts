import { z } from "zod";

import { HistoricalMissionBaseSchema } from "./shared.ts";

export const MissionV6Schema = HistoricalMissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v6"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
  origin: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user") }),
    z.object({ type: z.literal("system-memory"), jobId: z.string().min(1) }),
  ]),
});
