import { MissionV5Schema } from "../schemas/v5.ts";
import { MissionV6Schema } from "../schemas/v6.ts";

export const missionV5ToV6Step = {
  from: "pragma.mission/v5",
  to: "pragma.mission/v6",
  migrate(input: unknown) {
    return MissionV6Schema.parse({
      ...MissionV5Schema.parse(input),
      schemaVersion: "pragma.mission/v6",
      origin: { type: "user" },
    });
  },
} as const;
