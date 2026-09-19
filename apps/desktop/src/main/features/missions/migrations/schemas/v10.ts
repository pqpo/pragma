import { z } from "zod";

import {
  MissionBaseSchema,
  MissionBranchSourceSchema,
  MissionContextMountV10Schema,
  MissionOriginSchema,
} from "../../../../../shared/contracts/missions.ts";

export const MissionV10Schema = MissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v10"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
  origin: MissionOriginSchema.default({ type: "user" }),
  contextMounts: z.array(MissionContextMountV10Schema).max(200),
  branch: MissionBranchSourceSchema.optional(),
}).superRefine((mission, context) => {
  if (mission.executor.kind === "flow" && mission.flowInput === undefined) {
    context.addIssue({
      code: "custom",
      message: "Flow missions require flowInput.",
      path: ["flowInput"],
    });
  }
  if (mission.executor.kind !== "flow" && mission.flowInput !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Only Flow missions may store flowInput.",
      path: ["flowInput"],
    });
  }
  if (mission.branch !== undefined && mission.executor.kind === "flow") {
    context.addIssue({
      code: "custom",
      message: "Flow missions cannot be conversation branches.",
      path: ["branch"],
    });
  }
});
