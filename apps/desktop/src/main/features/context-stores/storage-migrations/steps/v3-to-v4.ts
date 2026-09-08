import { z } from "zod";

import type { ContextStoreSnapshot } from "../../../../../shared/contracts/index.ts";
import { LegacyContextStoreV3Schema, LegacyContextStoreV4Schema } from "../schemas.ts";

export function migrateContextStoreV3ToV4(
  source: z.infer<typeof LegacyContextStoreV3Schema>,
  snapshot: ContextStoreSnapshot,
): z.infer<typeof LegacyContextStoreV4Schema> {
  return LegacyContextStoreV4Schema.parse({
    ...source,
    schemaVersion: "pragma.context-store/v4",
    contentRevision: 1,
    snapshotHash: snapshot.snapshotHash,
  });
}
