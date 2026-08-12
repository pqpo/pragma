import { migrateEpisodicJobsV1ToV2 } from "./steps/v1-to-v2.ts";
import { migrateEpisodicJobsV2ToV3 } from "./steps/v2-to-v3.ts";
import { migrateEpisodicJobsV3ToV4 } from "./steps/v3-to-v4.ts";

export { EpisodicExtractionJobV1Schema } from "./schemas/v1.ts";
export { EpisodicExtractionJobV2Schema } from "./schemas/v2.ts";
export { EpisodicExtractionJobV3Schema } from "./schemas/v3.ts";
export { migrateEpisodicJobsV1ToV2 } from "./steps/v1-to-v2.ts";
export { migrateEpisodicJobsV2ToV3 } from "./steps/v2-to-v3.ts";
export { migrateEpisodicJobsV3ToV4 } from "./steps/v3-to-v4.ts";

export const EPISODIC_JOB_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateEpisodicJobsV1ToV2 },
  { fromVersion: 2, toVersion: 3, migrate: migrateEpisodicJobsV2ToV3 },
  { fromVersion: 3, toVersion: 4, migrate: migrateEpisodicJobsV3ToV4 },
] as const);
