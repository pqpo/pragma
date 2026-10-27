import type { StateMigrationStep } from "../../../state-migration.ts";
import { RuntimeSessionRecordV3Schema, type RuntimeSessionRecordV3 } from "../schemas/v3.ts";
import { RuntimeSessionRecordV4Schema } from "../schemas/v4.ts";

export const runtimeSessionV3ToV4Step: StateMigrationStep = {
  fromVersion: 3,
  toVersion: 4,
  inputSchema: RuntimeSessionRecordV3Schema,
  migrate(value) {
    const current = value as RuntimeSessionRecordV3;
    return RuntimeSessionRecordV4Schema.parse({
      ...current,
      schemaVersion: "pragma.runtime-session/v4",
      // The historical built-in Pi writer ran in its Host. Do not fabricate
      // a PID or turn a legacy running record into a confirmed stop.
      processOwner: current.runtime.kind === "cloud-pi-agent" ? { type: "legacy-host" } : null,
    });
  },
};
