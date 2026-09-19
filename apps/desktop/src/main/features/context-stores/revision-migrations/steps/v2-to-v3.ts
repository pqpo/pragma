import {
  ContextStoreRevisionJobSchema,
  type ContextStoreRevisionJob,
} from "@pragma/built-in-agents/contracts";

import type { ContextStoreRevisionJobV2 } from "../schemas/v2.ts";

export function migrateContextStoreRevisionJobV2ToV3(
  source: ContextStoreRevisionJobV2,
): ContextStoreRevisionJob {
  return ContextStoreRevisionJobSchema.parse({
    ...source,
    schemaVersion: "pragma.context-store-revision-job/v3",
    revision: source.revision + 1,
    request: {
      ...source.request,
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise",
    },
    updatedAt: new Date().toISOString(),
  });
}
