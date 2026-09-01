import { z } from "zod";

import {
  HistoricalMissionBaseSchema,
  HistoricalMissionBranchSourceV9Schema,
  HistoricalMissionOriginSchema,
  refineHistoricalFlowMission,
} from "./shared.ts";
import { MissionContextStoreIdsV8Schema } from "./v8.ts";

export const MissionV9Schema = HistoricalMissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v9"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
  origin: HistoricalMissionOriginSchema.default({ type: "user" }),
  contextStoreIds: MissionContextStoreIdsV8Schema,
  branch: HistoricalMissionBranchSourceV9Schema.optional(),
}).superRefine((mission, context) => {
  refineHistoricalFlowMission(mission, context);
  if (mission.branch !== undefined && mission.executor.kind === "flow") {
    context.addIssue({
      code: "custom",
      message: "Flow missions cannot be conversation branches.",
      path: ["branch"],
    });
  }
});
