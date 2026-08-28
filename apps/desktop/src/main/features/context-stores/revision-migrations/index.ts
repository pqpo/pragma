export { ContextStoreRevisionJobV1Schema } from "./schemas/v1.ts";
export { migrateContextStoreRevisionJobV1ToV2, overlayFromV1Job } from "./steps/v1-to-v2.ts";

import { migrateContextStoreRevisionJobV1ToV2 } from "./steps/v1-to-v2.ts";

export const CONTEXT_STORE_REVISION_JOB_MIGRATIONS = Object.freeze([
  Object.freeze({
    from: "pragma.context-store-revision-job/v1" as const,
    to: "pragma.context-store-revision-job/v2" as const,
    migrate: migrateContextStoreRevisionJobV1ToV2,
  }),
]);
