import type { StateMigrationStep } from "../../../state-migration.ts";
import {
  RuntimeSessionRecordV2Schema,
  type RuntimeSessionRecordV2,
} from "../schemas/v2.ts";
import { RuntimeSessionRecordV3Schema } from "../schemas/v3.ts";

export const runtimeSessionV2ToV3Step: StateMigrationStep = {
  fromVersion: 2,
  toVersion: 3,
  inputSchema: RuntimeSessionRecordV2Schema,
  migrate(value) {
    const current = value as RuntimeSessionRecordV2;
    return RuntimeSessionRecordV3Schema.parse({
      ...current,
      schemaVersion: "pragma.runtime-session/v3",
    });
  },
};
