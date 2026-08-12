import { migrateSemanticJobsV1ToV2 } from "./steps/v1-to-v2.ts";
import { migrateSemanticJobsV2ToV3 } from "./steps/v2-to-v3.ts";
import { migrateSemanticJobsV3ToV4 } from "./steps/v3-to-v4.ts";

export { SemanticExtractionJobV1Schema } from "./schemas/v1.ts";
export { SemanticExtractionJobV2Schema } from "./schemas/v2.ts";
export { SemanticExtractionJobV3Schema } from "./schemas/v3.ts";
export { migrateSemanticJobsV1ToV2 } from "./steps/v1-to-v2.ts";
export { migrateSemanticJobsV2ToV3 } from "./steps/v2-to-v3.ts";
export { migrateSemanticJobsV3ToV4 } from "./steps/v3-to-v4.ts";

export const SEMANTIC_JOB_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateSemanticJobsV1ToV2 },
  { fromVersion: 2, toVersion: 3, migrate: migrateSemanticJobsV2ToV3 },
  { fromVersion: 3, toVersion: 4, migrate: migrateSemanticJobsV3ToV4 },
] as const);
