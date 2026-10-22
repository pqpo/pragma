import { ContextStoreSchema } from "@pragma/shared";
import { ContextStoreRevisionJournalV1Schema, ContextStoreV4Schema } from "../schemas/v4.ts";
export function migrateContextStoreV4ToV5(raw: unknown) {
  const source = ContextStoreV4Schema.parse(raw);
  return ContextStoreSchema.parse({
    ...source,
    schemaVersion: "pragma.context-store/v5",
    writeApprovalMode: "required",
  });
}

export function migrateContextStoreRevisionJournalV1ToV2(raw: unknown) {
  const source = ContextStoreRevisionJournalV1Schema.parse(raw);
  return {
    ...source,
    schemaVersion: "pragma.context-store-revision-journal/v2" as const,
    targetManifest: migrateContextStoreV4ToV5(source.targetManifest),
  };
}
