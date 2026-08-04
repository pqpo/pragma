import { migrateSemanticDataV1ToV2 } from "./steps/v1-to-v2.ts";

export { SemanticFactV1Schema } from "./schemas/v1.ts";
export { SemanticFactV2StorageSchema } from "./schemas/v2.ts";
export { migrateSemanticDataV1ToV2 } from "./steps/v1-to-v2.ts";

export const SEMANTIC_DATA_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateSemanticDataV1ToV2 },
] as const);
