import { migrateCanonicalEventFeedV1ToV2 } from "./steps/v1-to-v2.ts";

export { CANONICAL_EVENT_FEED_V1_SCHEMA_SQL } from "./schemas/v1.ts";
export { CANONICAL_EVENT_FEED_V2_SCHEMA_SQL } from "./schemas/v2.ts";
export { migrateCanonicalEventFeedV1ToV2 } from "./steps/v1-to-v2.ts";

export const CANONICAL_EVENT_FEED_STORAGE_MIGRATIONS = [
  { fromVersion: 1, toVersion: 2, migrate: migrateCanonicalEventFeedV1ToV2 },
] as const;
