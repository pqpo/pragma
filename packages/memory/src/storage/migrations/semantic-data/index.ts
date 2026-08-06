import { migrateSemanticDataV1ToV2 } from "./steps/v1-to-v2.ts";
import { migrateSemanticDataV2ToV3 } from "./steps/v2-to-v3.ts";
import { migrateSemanticDataV3ToV4 } from "./steps/v3-to-v4.ts";

export { SemanticFactV1Schema } from "./schemas/v1.ts";
export { SemanticFactV2StorageSchema } from "./schemas/v2.ts";
export { SemanticFactV3StorageSchema } from "./schemas/v3.ts";
export { migrateSemanticDataV1ToV2 } from "./steps/v1-to-v2.ts";
export { migrateSemanticDataV2ToV3 } from "./steps/v2-to-v3.ts";
export { migrateSemanticDataV3ToV4 } from "./steps/v3-to-v4.ts";

export const SEMANTIC_DATA_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateSemanticDataV1ToV2 },
  { fromVersion: 2, toVersion: 3, migrate: migrateSemanticDataV2ToV3 },
  { fromVersion: 3, toVersion: 4, migrate: migrateSemanticDataV3ToV4 },
] as const);
