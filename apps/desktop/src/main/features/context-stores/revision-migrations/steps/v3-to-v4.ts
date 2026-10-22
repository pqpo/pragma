import { ContextStoreRevisionJobSchema } from "@pragma/built-in-agents/contracts";
import { ContextStoreRevisionJobV3Schema } from "../schemas/v3.ts";
export function migrateContextStoreRevisionJobV3ToV4(raw: unknown) {
  const source = ContextStoreRevisionJobV3Schema.parse(raw);
  return ContextStoreRevisionJobSchema.parse({
    ...source,
    schemaVersion: "pragma.context-store-revision-job/v4",
    submissionApprovalMode: "required",
  });
}
