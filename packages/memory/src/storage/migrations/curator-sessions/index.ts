import { migrateCuratorSessionsV2ToV3 } from "./steps/v2-to-v3.ts";
import { migrateCuratorSessionsV1ToV2 } from "./steps/v1-to-v2.ts";
export const CURATOR_SESSION_MIGRATIONS = Object.freeze([
  { fromVersion: 1, toVersion: 2, migrate: migrateCuratorSessionsV1ToV2 },
  { fromVersion: 2, toVersion: 3, migrate: migrateCuratorSessionsV2ToV3 },
]);
