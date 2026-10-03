import { MissionV7Schema } from "../schemas/v7.ts";
import { MissionV8Schema } from "../schemas/v8.ts";

export const missionV7ToV8Step = {
  from: "pragma.mission/v7",
  to: "pragma.mission/v8",
  migrate(input: unknown) {
    return MissionV8Schema.parse({
      ...MissionV7Schema.parse(input),
      schemaVersion: "pragma.mission/v8",
      contextStoreIds: [],
    });
  },
} as const;
