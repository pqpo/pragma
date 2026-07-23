import { defineStateMigrationChain } from "../../state-migration.ts";
import { RuntimeSessionRecordV2Schema, type RuntimeSessionRecordV2 } from "./schemas/v2.ts";

export {
  RuntimeSessionRecordV2Schema as RuntimeSessionRecordSchema,
  type RuntimeSessionRecordV2 as RuntimeSessionRecord,
} from "./schemas/v2.ts";

export const runtimeSessionRecordMigrationChain = defineStateMigrationChain<RuntimeSessionRecordV2>(
  {
    family: "pragma.runtime-session",
    currentVersion: 2,
    currentSchema: RuntimeSessionRecordV2Schema,
  },
);
