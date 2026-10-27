import { defineStateMigrationChain } from "../../state-migration.ts";
import { RuntimeSessionRecordV4Schema, type RuntimeSessionRecordV4 } from "./schemas/v4.ts";
import { runtimeSessionV3ToV4Step } from "./steps/v3-to-v4.ts";
import { runtimeSessionV2ToV3Step } from "./steps/v2-to-v3.ts";

export {
  RuntimeSessionRecordV4Schema as RuntimeSessionRecordSchema,
  type RuntimeSessionRecordV4 as RuntimeSessionRecord,
  RuntimeHostProcessSchema,
  type RuntimeHostProcess,
} from "./schemas/v4.ts";
export { RuntimeSessionRecordV2Schema } from "./schemas/v2.ts";
export { RuntimeSessionRecordV3Schema, RuntimeContextWindowUsageV3Schema } from "./schemas/v3.ts";

export const runtimeSessionRecordMigrationChain = defineStateMigrationChain<RuntimeSessionRecordV4>(
  {
    family: "pragma.runtime-session",
    currentVersion: 4,
    currentSchema: RuntimeSessionRecordV4Schema,
    steps: [runtimeSessionV2ToV3Step, runtimeSessionV3ToV4Step],
  },
);
