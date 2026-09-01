import { MissionV6Schema } from "../schemas/v6.ts";
import { MissionV7Schema } from "../schemas/v7.ts";

export const missionV6ToV7Step = {
  from: "pragma.mission/v6",
  to: "pragma.mission/v7",
  migrate(input: unknown) {
    return MissionV7Schema.parse({
      ...MissionV6Schema.parse(input),
      schemaVersion: "pragma.mission/v7",
    });
  },
} as const;
