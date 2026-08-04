import { migrateSemanticJobsV1ToV2 } from "./steps/v1-to-v2.ts";
import { migrateSemanticJobsV2ToV3 } from "./steps/v2-to-v3.ts";

export { SemanticExtractionJobV1Schema } from "./schemas/v1.ts";
export { SemanticExtractionJobV2Schema } from "./schemas/v2.ts";
export { migrateSemanticJobsV1ToV2 } from "./steps/v1-to-v2.ts";
export { migrateSemanticJobsV2ToV3 } from "./steps/v2-to-v3.ts";

export const SEMANTIC_JOB_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateSemanticJobsV1ToV2 },
  { fromVersion: 2, toVersion: 3, migrate: migrateSemanticJobsV2ToV3 },
] as const);
