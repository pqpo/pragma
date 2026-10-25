import { MissionSchema } from "@pragma/shared";
import { MissionV11Schema } from "../schemas/v11.ts";
export const missionV11ToV12Step = {
  from: "pragma.mission/v11",
  to: "pragma.mission/v12",
  migrate(input: unknown) {
    const { toolPermissionMode: _retiredMode, ...mission } = MissionV11Schema.parse(input);
    void _retiredMode;
    return MissionSchema.parse({ ...mission, schemaVersion: "pragma.mission/v12" });
  },
} as const;
