import { migrateEpisodicDataV1ToV2 } from "./steps/v1-to-v2.ts";
import { migrateEpisodicDataV2ToV3 } from "./steps/v2-to-v3.ts";

export { EpisodicMemoryRecordV1Schema } from "./schemas/v1.ts";
export { EpisodicMemoryRecordV2Schema } from "./schemas/v2.ts";
export { migrateEpisodicDataV1ToV2 } from "./steps/v1-to-v2.ts";
export { migrateEpisodicDataV2ToV3 } from "./steps/v2-to-v3.ts";

export const EPISODIC_DATA_STORAGE_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateEpisodicDataV1ToV2 },
  { fromVersion: 2, toVersion: 3, migrate: migrateEpisodicDataV2ToV3 },
] as const);
