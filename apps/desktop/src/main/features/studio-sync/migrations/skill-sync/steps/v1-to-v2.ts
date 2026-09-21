import type { StateMigrationStep } from "@pragma/core";

import { SkillSyncStateV1Schema } from "../schemas/v1.ts";
import { SkillSyncStateV2Schema } from "../schemas/v2.ts";

export const skillSyncStateV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: SkillSyncStateV1Schema,
  migrate(value) {
    const source = SkillSyncStateV1Schema.parse(value);
    return SkillSyncStateV2Schema.parse({
      ...source,
      schemaVersion: "pragma.skill-sync-state/v2",
    });
  },
} satisfies StateMigrationStep;
