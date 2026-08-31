import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExpertSessionRecordV5Schema } from "../schemas/v5.ts";
import { ExpertSessionRecordV6Schema } from "../schemas/v6.ts";

export const expertSessionV5ToV6Step = {
  fromVersion: 5,
  toVersion: 6,
  inputSchema: ExpertSessionRecordV5Schema,
  migrate(value) {
    const current = ExpertSessionRecordV5Schema.parse(value);
    return ExpertSessionRecordV6Schema.parse({
      ...current,
      schemaVersion: "pragma.expert-session/v6",
    });
  },
} satisfies StateMigrationStep;
