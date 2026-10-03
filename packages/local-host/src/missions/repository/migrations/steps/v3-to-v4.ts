import { MissionV3Schema } from "../schemas/v3.ts";
import { MissionV4Schema } from "../schemas/v4.ts";

export const missionV3ToV4Step = {
  from: "pragma.mission/v3",
  to: "pragma.mission/v4",
  migrate(input: unknown) {
    const legacy = MissionV3Schema.parse(input);
    return MissionV4Schema.parse({
      ...legacy,
      schemaVersion: "pragma.mission/v4",
      ...(legacy.executor.kind === "flow"
        ? { flowInput: { goal: legacy.goal, workspace: legacy.workspace.path } }
        : {}),
    });
  },
} as const;
