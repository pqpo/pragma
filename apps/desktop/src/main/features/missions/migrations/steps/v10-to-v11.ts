import { MissionSchema } from "../../../../../shared/contracts/missions.ts";
import { MissionV10Schema } from "../schemas/v10.ts";

export const missionV10ToV11Step = {
  from: "pragma.mission/v10",
  to: "pragma.mission/v11",
  migrate(input: unknown) {
    const legacy = MissionV10Schema.parse(input);
    return MissionSchema.parse({ ...legacy, schemaVersion: "pragma.mission/v11" });
  },
} as const;
