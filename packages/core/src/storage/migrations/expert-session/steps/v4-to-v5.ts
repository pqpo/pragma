import type { StateMigrationStep } from "../../../state-migration.ts";
import { ExpertSessionRecordV4Schema } from "../schemas/v4.ts";
import { ExpertSessionRecordV5Schema } from "../schemas/v5.ts";

export const expertSessionV4ToV5Step = {
  fromVersion: 4,
  toVersion: 5,
  inputSchema: ExpertSessionRecordV4Schema,
  migrate(value) {
    const current = ExpertSessionRecordV4Schema.parse(value);
    const { expertVersion: _expertVersion, ...session } = current;
    void _expertVersion;
    return ExpertSessionRecordV5Schema.parse({
      ...session,
      schemaVersion: "pragma.expert-session/v5",
      contexts: Object.fromEntries(
        Object.entries(current.contexts).map(([contextId, context]) => {
          const { version: _version, ...expert } = context.expert;
          void _version;
          return [
            contextId,
            {
              ...context,
              schemaVersion: "pragma.runtime-context/v5",
              expert,
            },
          ];
        }),
      ),
    });
  },
} satisfies StateMigrationStep;
