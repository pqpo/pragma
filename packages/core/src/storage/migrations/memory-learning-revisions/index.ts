import { MemoryLearningStateV1Schema } from "./schemas/v1.ts";
import { migrateMemoryLearningStateV1ToV2 } from "./steps/v1-to-v2.ts";
export const MEMORY_LEARNING_REVISION_MIGRATIONS = Object.freeze([
  {
    fromVersion: 1,
    toVersion: 2,
    inputSchema: MemoryLearningStateV1Schema,
    migrate: migrateMemoryLearningStateV1ToV2,
  },
] as const);
