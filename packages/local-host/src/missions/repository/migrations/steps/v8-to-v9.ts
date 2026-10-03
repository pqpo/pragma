import { MissionV8Schema } from "../schemas/v8.ts";
import { MissionV9Schema } from "../schemas/v9.ts";

export const missionV8ToV9Step = {
  from: "pragma.mission/v8",
  to: "pragma.mission/v9",
  migrate(input: unknown) {
    return MissionV9Schema.parse({
      ...MissionV8Schema.parse(input),
      schemaVersion: "pragma.mission/v9",
    });
  },
} as const;
