import { migrateEpisodicDataV1ToV2 } from "./steps/v1-to-v2.ts";

export { EpisodicMemoryRecordV1Schema } from "./schemas/v1.ts";
export { EpisodicMemoryRecordV2Schema } from "./schemas/v2.ts";
export { migrateEpisodicDataV1ToV2 } from "./steps/v1-to-v2.ts";

export const EPISODIC_DATA_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateEpisodicDataV1ToV2 },
] as const);
