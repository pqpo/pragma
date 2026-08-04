import { migrateSemanticJobsV1ToV2 } from "./steps/v1-to-v2.ts";

export { SemanticExtractionJobV1Schema } from "./schemas/v1.ts";
export { SemanticExtractionJobV2Schema } from "./schemas/v2.ts";
export { migrateSemanticJobsV1ToV2 } from "./steps/v1-to-v2.ts";

export const SEMANTIC_JOB_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateSemanticJobsV1ToV2 },
] as const);
