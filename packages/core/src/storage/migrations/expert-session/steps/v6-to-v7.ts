import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExpertSessionRecordV6Schema } from "../schemas/v6.ts";
import { ExpertSessionRecordV7Schema } from "../schemas/v7.ts";

export const expertSessionV6ToV7Step = {
  fromVersion: 6,
  toVersion: 7,
  inputSchema: ExpertSessionRecordV6Schema,
  migrate(value) {
    const current = ExpertSessionRecordV6Schema.parse(value);
    return ExpertSessionRecordV7Schema.parse({
      ...current,
      schemaVersion: "pragma.expert-session/v7",
    });
  },
} satisfies StateMigrationStep;
