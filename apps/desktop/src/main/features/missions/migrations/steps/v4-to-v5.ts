import { migrateLegacyPragmaResourceRef } from "@pragma/interpreter";

import { MissionV4Schema } from "../schemas/v4.ts";
import { MissionV5Schema } from "../schemas/v5.ts";

export const missionV4ToV5Step = {
  from: "pragma.mission/v4",
  to: "pragma.mission/v5",
  migrate(input: unknown) {
    const legacy = MissionV4Schema.parse(input);
    const { version: _version, ...executor } = legacy.executor;
    void _version;
    return MissionV5Schema.parse({
      ...legacy,
      schemaVersion: "pragma.mission/v5",
      executor: {
        ...executor,
        ref: migrateLegacyPragmaResourceRef(executor.ref, legacy.project.id),
      },
    });
  },
} as const;
