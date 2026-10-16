import { migrateCuratorSessionsV1ToV2 } from "./steps/v1-to-v2.ts";
export const CURATOR_SESSION_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateCuratorSessionsV1ToV2 },
]);
