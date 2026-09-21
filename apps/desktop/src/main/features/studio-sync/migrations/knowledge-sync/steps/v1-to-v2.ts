import type { StateMigrationStep } from "@pragma/core";

import { KnowledgeSyncStateV1Schema } from "../schemas/v1.ts";
import { KnowledgeSyncStateV2Schema } from "../schemas/v2.ts";

export const knowledgeSyncStateV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: KnowledgeSyncStateV1Schema,
  migrate(value) {
    const source = KnowledgeSyncStateV1Schema.parse(value);
    return KnowledgeSyncStateV2Schema.parse({
      ...source,
      schemaVersion: "pragma.knowledge-sync-state/v2",
    });
  },
} satisfies StateMigrationStep;
