import type { z } from "zod";

import { ContextStoreSchema, type ContextStore } from "../../../../../shared/contracts/index.ts";
import { LegacyContextStoreV4Schema } from "../schemas.ts";

export function migrateContextStoreV4ToV5(
  source: z.infer<typeof LegacyContextStoreV4Schema>,
): ContextStore {
  return ContextStoreSchema.parse({
    ...source,
    schemaVersion: "pragma.context-store/v5",
    contentRevision: undefined,
  });
}
