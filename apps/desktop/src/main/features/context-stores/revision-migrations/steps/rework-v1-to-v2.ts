import { KnowledgeRevisionReworkV1Schema } from "../schemas/v3.ts";
import { migrateContextStoreRevisionJobV3ToV4 } from "./v3-to-v4.ts";
export function migrateKnowledgeRevisionReworkV1ToV2(raw: unknown) {
  const source = KnowledgeRevisionReworkV1Schema.parse(raw);
  return {
    ...source,
    schemaVersion: "pragma.knowledge-revision-rework/v2" as const,
    nextJob: migrateContextStoreRevisionJobV3ToV4(source.nextJob),
  };
}
