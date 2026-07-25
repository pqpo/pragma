import { defineStateMigrationChain } from "../../state-migration.ts";
import { RuntimeSessionRecordV3Schema, type RuntimeSessionRecordV3 } from "./schemas/v3.ts";
import { runtimeSessionV2ToV3Step } from "./steps/v2-to-v3.ts";

export {
  RuntimeSessionRecordV3Schema as RuntimeSessionRecordSchema,
  type RuntimeSessionRecordV3 as RuntimeSessionRecord,
} from "./schemas/v3.ts";
export { RuntimeSessionRecordV2Schema } from "./schemas/v2.ts";
export { RuntimeSessionRecordV3Schema, RuntimeContextWindowUsageV3Schema } from "./schemas/v3.ts";

export const runtimeSessionRecordMigrationChain = defineStateMigrationChain<RuntimeSessionRecordV3>(
  {
    family: "pragma.runtime-session",
    currentVersion: 3,
    currentSchema: RuntimeSessionRecordV3Schema,
    steps: [runtimeSessionV2ToV3Step],
  },
);
