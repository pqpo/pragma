import { migrateEpisodicJobsV1ToV2 } from "./steps/v1-to-v2.ts";

export { EpisodicExtractionJobV1Schema } from "./schemas/v1.ts";
export { EpisodicExtractionJobV2Schema } from "./schemas/v2.ts";
export { migrateEpisodicJobsV1ToV2 } from "./steps/v1-to-v2.ts";

export const EPISODIC_JOB_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateEpisodicJobsV1ToV2 },
] as const);
